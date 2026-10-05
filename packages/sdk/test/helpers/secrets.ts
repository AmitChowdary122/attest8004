import { expect } from "vitest";
import type { SecretTracker } from "../../src/inbox-crypto.ts";

/** A `SecretTracker` that keeps every buffer it is handed, so a test can check afterwards that each one was zeroed. */
export function recordingTracker(): SecretTracker & { buffers: Uint8Array[] } {
  const buffers: Uint8Array[] = [];
  return {
    buffers,
    track(buffer: Uint8Array): void {
      buffers.push(buffer);
    },
  };
}

/** Fails, naming each offending index, unless every byte of every buffer is zero. */
export function expectAllZero(buffers: Uint8Array[]): void {
  const nonZero = buffers.flatMap((buffer, index) => (buffer.some((byte) => byte !== 0) ? [index] : []));
  expect(nonZero, `buffers not zeroed, at index ${nonZero.join(", ")}`).toEqual([]);
}
