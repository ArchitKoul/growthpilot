import "server-only";
import { z } from "zod";
import { DatasetMetaSchema, EventSchema, type Dataset } from "../analytics/schema";
import { getSyntheticDataset, SYNTHETIC_DATASET_ID } from "../analytics/synthetic";

export const MAX_UPLOADED_EVENTS = 60_000;

/**
 * The client tells the server which dataset to analyse. The synthetic dataset
 * is regenerated server-side (deterministic). Uploaded datasets are sent with
 * the request, validated event-by-event, and never stored or merged.
 */
export const DatasetRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("synthetic"), id: z.literal(SYNTHETIC_DATASET_ID) }).strict(),
  z
    .object({
      kind: z.literal("upload"),
      meta: DatasetMetaSchema.extend({ source: z.literal("upload") }),
      events: z.array(EventSchema).min(1).max(MAX_UPLOADED_EVENTS),
    })
    .strict(),
]);
export type DatasetRef = z.infer<typeof DatasetRefSchema>;

export function resolveDataset(ref: DatasetRef): Dataset {
  if (ref.kind === "synthetic") return getSyntheticDataset();
  return { meta: { ...ref.meta, rowCount: ref.events.length }, events: ref.events };
}
