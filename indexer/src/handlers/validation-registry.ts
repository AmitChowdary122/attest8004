// ValidationRegistry: one row per request carrying its latest response (as getValidationStatus reports it), every
// response event kept, and the validator, agent and agent-tag stats (ARCHITECTURE §6, plan decisions 11–13).
import { indexer } from "envio";
import { decodeEvidence, decodeRequest } from "../lib/decode.ts";
import { reevaluatePosts } from "./findings-board.ts";
import { anchorOf, applyToAgentTags, applyToValidator, bumpSummary, eventId, newValidator, touchAgent } from "./shared.ts";

indexer.onEvent({ contract: "ValidationRegistry", event: "ValidationRequest" }, async ({ event, context }) => {
  const a = anchorOf(event);
  const id = event.params.requestHash.toLowerCase();
  const agentId = event.params.agentId.toString();
  const validator = event.params.validatorAddress.toLowerCase();
  // The registry refuses a second request with the same hash (RequestExists), so this row is written once.
  const decoded = decodeRequest(event.params.requestURI, id, event.chainId);
  const verified = decoded.status === "VERIFIED" ? decoded : null;
  context.ValidationRequest.set({
    id,
    agentId,
    validator,
    requestBlock: a.block,
    requestTime: a.time,
    requestTx: a.tx,
    requestStatus: decoded.status,
    gate: verified?.gate,
    target: verified?.target,
    value: verified?.value,
    deadline: verified?.deadline,
    actionHash: verified?.actionHash,
    responses: 0,
    score: undefined,
    tag: undefined,
    responseHash: undefined,
    reasons: undefined,
    evidenceStatus: undefined,
    responseBlock: undefined,
    responseTime: undefined,
    responseTx: undefined,
    firstResponseBlock: undefined,
    executedTx: undefined,
    executedBlock: undefined,
  });

  await touchAgent(context, agentId, a.block);
  await bumpSummary(context, agentId, a.block, { requests: 1 });
  const v = (await context.Validator.get(validator)) ?? newValidator(validator, a.block);
  context.Validator.set({ ...v, requests: v.requests + 1, lastActivityBlock: a.block });
  // A report posted before its request is judged now (decision 15).
  await reevaluatePosts(context, { id, validator, agentId }, a.block);
});

indexer.onEvent({ contract: "ValidationRegistry", event: "ValidationResponse" }, async ({ event, context }) => {
  const a = anchorOf(event);
  const id = event.params.requestHash.toLowerCase();
  const score = Number(event.params.response);
  const tag = event.params.tag;
  const responseHash = event.params.responseHash.toLowerCase();
  const evidence = decodeEvidence(event.params.responseURI, responseHash);
  context.ValidationResponse.set({
    id: eventId(a),
    requestHash: id,
    agentId: event.params.agentId.toString(),
    validator: event.params.validatorAddress.toLowerCase(),
    score,
    tag,
    responseHash,
    reasons: evidence.reasons ?? undefined,
    evidenceStatus: evidence.status,
    block: a.block,
    time: a.time,
    tx: a.tx,
    logIndex: a.logIndex,
  });

  const request = await context.ValidationRequest.get(id);
  if (!request) {
    // The registry answers only requests it holds (UnknownRequest), so this can't happen onchain.
    context.log.warn(`ValidationResponse for an unindexed request ${id}: stored, not counted`);
    return;
  }
  const previous = request.responses > 0 && request.score !== undefined && request.tag !== undefined ? { score: request.score, tag: request.tag } : null;
  const next = { score, tag };
  context.ValidationRequest.set({
    ...request,
    responses: request.responses + 1,
    score,
    tag,
    responseHash,
    reasons: evidence.reasons ?? undefined,
    evidenceStatus: evidence.status,
    responseBlock: a.block,
    responseTime: a.time,
    responseTx: a.tx,
    firstResponseBlock: request.firstResponseBlock ?? a.block,
  });

  const v = (await context.Validator.get(request.validator)) ?? newValidator(request.validator, a.block);
  context.Validator.set(applyToValidator(v, previous, next, a.block, previous ? null : a.block - request.requestBlock));
  await applyToAgentTags(context, request.agentId, id, previous, next, a.block);
  await bumpSummary(context, request.agentId, a.block, previous ? {} : { answered: 1 });
});
