# The Mera findings inbox

Attest8004's validators publish every verdict's evidence in public plaintext, because anyone must be able to re-check
it (`pnpm attest8004 verify`). Next to that, each validator sends the agent's operator a **private operator report**:
the verdict in plain words, with recommended actions, encrypted to a key that only the operator's passkey can derive.
This page explains how that key works, what is on chain, and how the same passkey reads the reports on a second device.

SPEC §4.7 is the scope. ARCHITECTURE §5.4 has the flow and §6 the formats (the envelope, the report, the trust rule).

## 1. Why this is non-account use of Mera

[Mera](https://mera.category.xyz) turns a passkey's WebAuthn PRF into bytes an application can use. Most uses derive
a wallet. Attest8004 derives **no wallet, no address, no signing key and no account**: one PRF namespace,
`sha256("attest8004.inbox.v1")`, derives an **X25519 encryption key**, and nothing else.

```
passkey (Google Password Manager, synced)
  └─ Mera getPasskeyPrfOutput(salt = sha256("attest8004.inbox.v1"))        32 bytes, in memory
       └─ HKDF-SHA256(salt = empty, info = "attest8004.inbox.x25519.v1")   32 bytes
            └─ clamp (RFC 7748)  → X25519 private key                      in memory, zeroed after use
                 └─ X25519(priv, 9) → inbox public key                     published once, on chain
```

The passkey has a second job, but it is separate and doesn't use Mera: its P-256 key signs WebAuthn assertions that
`MandateRegistry` verifies through Monad's P256 precompile (`0x0100`) to approve mandate changes (SPEC §4.2). The inbox
key is never an account. It only decrypts.

Salts are namespaces: the PRF output for the inbox salt is unrelated to the output for any other salt. `/approve`'s
PRF check uses a different, check-only salt (`sha256("attest8004.prf-check.v1")`), so the fingerprint it shows reveals
nothing about the inbox key.

## 2. The key lifecycle

| Moment | Where | What exists | What is zeroed, and when |
|---|---|---|---|
| **Publish** (once per agent) | `/approve`, section 4 | (a) The PRF output, then the private key, then the public key. The page keeps only the credential id and the public key | The PRF output and the private key, in `finally` inside `inboxPublicKeyFromPrf`, before it returns; the PRF output again in the page's own `finally` |
| | `/approve`, section 4 | (b) A WebAuthn assertion over `setInboxKey`'s challenge, from the **same credential** (`allowCredentials`), verified against the agent's onchain passkey | Nothing secret: an assertion is public once submitted |
| | `submit-approval` | The owner's transaction: `setInboxKey(agentId, x25519Pub, auth)`, the same two factors as a mandate change | — |
| **Validators post** | each validator, after its response lands | An ephemeral X25519 key, the ECDH shared secret, the AEAD key | All three, in `finally` inside `sealEnvelope` |
| **Read** (any device) | `/inbox` | The PRF output, the private key (inside `withInboxKey` only), each envelope's shared secret and AEAD key, each decrypted plaintext | The PRF output and private key when `withInboxKey` returns (also on a throw); each shared secret and AEAD key in `openEnvelope`'s `finally`; each plaintext once decoded |

The private key exists only for the decryption itself: `/inbox` first finds the reports with public reads, and only
then asks for the passkey.

**What can't be zeroed** (stated plainly, as Mera's own security model does):
- noble's X25519 works on JavaScript `bigint`s internally, and those can't be overwritten;
- the browser's own PRF result (`getClientExtensionResults().prf.results.first`) is an `ArrayBuffer` that Mera copies
  from; the copy is ours and is zeroed, the original is the browser's;
- a decrypted report becomes JavaScript strings for display, which stay in memory until the page drops them ("Forget
  decrypted reports" or a reload) and the garbage collector reclaims them;
- the engine may copy any buffer while it runs.

Zeroing is defence in depth: it shortens how long a secret sits in memory; it can't promise that no copy exists.
Every zeroing path is tested (`packages/sdk/test/inbox-crypto.test.ts` and `inbox-read.test.ts`).

**Nothing is stored anywhere.** No localStorage, sessionStorage, IndexedDB, cookie, Cache API, service worker or
server: `web/test/no-storage.test.ts` forbids every one of them in the pages' source, and the pages talk only to the
public Monad RPC (the CSP's `connect-src`).

## 3. What's on chain

- **The inbox public key**, in `MandateRegistry.inboxKeyOf(agentId)`, set by `setInboxKey` (event `InboxKeySet`).
- **Ciphertext only**, in `FindingsBoard`'s `FindingsPosted(requestHash, agentId, validator, envelope)` events. The
  envelope is `0x01 ‖ ephemeral X25519 public key (32) ‖ nonce (12) ‖ AES-256-GCM ciphertext and tag`, at most 8,192
  bytes. The AAD binds the chain, the board, the ValidationRegistry, the request, the agent, the validator and the
  recipient key, so a ciphertext can't be presented as another request's, agent's or validator's report.

Anyone can see that a validator posted a report for a request and an agent, and how long it is. Nobody but the
holder of the agent's passkey can read it.

**The trust rule.** Anyone can post to the board. A reader keeps a post only when
`ValidationRegistry.getValidationStatus(requestHash)` names that post's validator and agent; every other post is
ignored, so a stranger can't slip a fake "report" into the inbox.

**Finding the reports without an indexer.** `/inbox` reads the agent's verdicts from the ValidationRegistry, then
looks for each verdict's report in the 600 blocks (about 3 minutes) after its response; validators post right after
their response lands. A report posted later than that isn't found until the P8 indexer. A post can be found only
after its verdict exists.

## 4. What the report contains, and why it is private

An `attest8004.report.v1` document: the validator's tag, the request, the score, the public evidence's hash (so the
page can say "matches the verdict onchain"), a summary, one item per reason or finding, and notes.

- **`mandate-v1`**: each failed rule in one sentence, with what to do about it, and the agent's daily spend (what
  is already counted against the cap, and what this action asks for).
- **`risk-v1`**: each finding's explanation (the model's words, or code's for a prompt-injection flag) with a
  recommended action from a fixed table in code. The model never writes the recommendation, so it can't be
  prompt-injected, and the score stays code's alone.

**Why encrypt it, when the evidence is public?** Today the report adds no hidden facts: it is the verdict read out
for its operator, with recommendations. Its purpose is the channel:
- operator-facing advice ("revoke the mandate now", "don't execute it") is addressed to the agent's operator, not
  to everyone watching the chain;
- **it is where licensed third-party data belongs.** Data such as Nansen labels is licensed for use, not for
  republishing. A validator must not copy it into public evidence that anyone can download, but it can put it in a
  report that only the agent's operator can decrypt. No recorded run has had a `NANSEN_API_KEY` set: `risk-v1`'s Nansen tools
  answered "unavailable", so no Nansen data is in any public evidence. If Nansen data is ever served, `risk-v1`'s
  public evidence (which records every tool output) would carry it. Whether that needs a `risk-v2` that keeps Nansen
  outputs out of public evidence and only in the inbox is a decision recorded for P10 (STATUS.md).

## 5. The cross-device test

The same Google Password Manager passkey, synced to an Android phone, gives the same PRF output for the same salt, so
the phone derives the same inbox key and decrypts the same reports, with nothing stored on either device.

**The procedure:**
1. On laptop Chrome, `https://attest8004.vercel.app/approve`, section 4: derive the inbox key from agent 1984's
   passkey, approve `setInboxKey`, and the owner submits it.
2. The end-to-end run: both validators answer three actions, and each response gets an encrypted report.
3. On laptop Chrome, `https://attest8004.vercel.app/inbox`, agent 1984: **Find reports**, then **Decrypt with
   passkey**. The page shows that this passkey derives agent 1984's inbox key, and the six reports.
4. On Android Chrome, the same page: **Find reports**, **Decrypt with passkey**, screen lock. The inbox key line
   must equal the laptop's, and the six reports must be the same.

**Results:** the P7 live run is pending; it is recorded here and in `docs/deployments.md` once done.
