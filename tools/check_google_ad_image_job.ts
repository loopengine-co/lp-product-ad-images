import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolDefinition } from 'loopengine'

// Mirrors generate_google_ad_images.ts's own jobPath — the two tools
// can't share a module (add-ability copies each tool file standalone,
// flattened, with no shared-module support), so this on-disk path
// convention is the actual contract between them, not a shared function.
function jobPath(outputDir: string, jobId: string): string {
  return join(outputDir, '.jobs', `${jobId}.json`)
}

export const checkGoogleAdImageJob: ToolDefinition = {
  name: 'check_google_ad_image_job',
  description:
    'Check the status of a job started by generate_google_ad_images — one job covers the whole batch (every shot, every ratio), not just one image. Returns {"status":"processing"|"done"|"partial"|"failed", "progress":{"total","done","failed","processing"}, "results":[...]}. results fills in incrementally as each shot/ratio finishes — check it even while status is still "processing" to see what\'s ready so far. "partial" means some units succeeded and some failed; check each result entry\'s own "status"/"error" to see which. Poll this rather than assuming the batch finished right away — a batch of many shots can take several minutes.',
  input_schema: {
    type: 'object',
    properties: {
      job_id: {
        type: 'string',
        description: 'The job_id returned by generate_google_ad_images.',
      },
    },
    required: ['job_id'],
  },
  execute: async (input) => {
    const jobId = String(input.job_id)
    const outputDir = process.env.AD_IMAGE_OUTPUT_DIR || './generated/ad-images'
    try {
      return await readFile(jobPath(outputDir, jobId), 'utf8')
    } catch {
      throw new Error(
        `check_google_ad_image_job: no job found for job_id "${jobId}" — check the id, and that AD_IMAGE_OUTPUT_DIR hasn't changed since the job was started.`,
      )
    }
  },
  // Read-only — never writes anything, safe to run alongside anything else.
  safe: true,
}
