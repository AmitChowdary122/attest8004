// Score buckets for validator stats (plan decision 13).

export type ScoreBucket = "score0" | "score1to39" | "score40to79" | "score80to99" | "score100";

export function scoreBucket(score: number): ScoreBucket {
  if (score <= 0) return "score0";
  if (score < 40) return "score1to39";
  if (score < 80) return "score40to79";
  if (score < 100) return "score80to99";
  return "score100";
}
