/**
 * ML inference worker — runs in an Electron utility process (see
 * `ml/mlHost.ts`), never in the main process.
 *
 * onnxruntime-node and its DirectML / CoreML providers are native code: a
 * driver fault, OOM abort or ORT assert used to take down the whole app,
 * and the synchronous pre/post-processing around each inference froze every
 * window. Here a crash only ends this process; the host reports it and
 * starts a fresh worker for the next request.
 *
 * Everything model-related (file lookups, the RVM download, inference) lives
 * here, so the main-process bundle doesn't include these modules at all.
 *
 * Protocol (structured-clone messages over `process.parentPort`):
 *   host → worker  { type: 'init', paths }
 *                  { type: 'run', id, job }
 *   worker → host  { type: 'progress', id, loaded, total }
 *                  { type: 'result', id, result }
 *                  { type: 'error', id, message }
 */
import { setMlPaths } from './ml/paths'
import type { MlPaths } from './ml/paths'
import type { MlJob } from './ml/mlJobs'
import { checkIsnetModel, runIsnet, invalidateIsnetSession } from './isnet'
import { checkInpaintModel, runInpaint, invalidateInpaintSession } from './inpaint'
import {
  checkMattingModel,
  downloadMattingModel,
  refineMatting,
  invalidateMattingSession,
} from './matting'
import {
  checkUpscaleModel,
  listUpscaleModels,
  runUpscaleJob,
  invalidateUpscaleSession,
} from './upscale'

type HostMessage =
  | { type: 'init'; paths: MlPaths }
  | { type: 'run'; id: number; job: MlJob }

const port = process.parentPort

function post(message: unknown): void {
  port.postMessage(message)
}

async function run(id: number, job: MlJob): Promise<unknown> {
  switch (job.kind) {
    case 'isnet':
      return runIsnet(job.params)
    case 'inpaint':
      return runInpaint(job.params)
    case 'matting':
      return refineMatting(job.params)
    case 'upscale':
      return runUpscaleJob(job.params, (loaded, total) => {
        post({ type: 'progress', id, loaded, total })
      })
    case 'check':
      switch (job.model) {
        case 'isnet':
          return checkIsnetModel()
        case 'inpaint':
          return checkInpaintModel()
        case 'matting':
          return checkMattingModel()
        case 'upscale':
          return checkUpscaleModel(job.modelId ?? '')
      }
      return undefined
    case 'list-upscale-models':
      return listUpscaleModels()
    case 'download-matting':
      await downloadMattingModel((loaded, total) => {
        post({ type: 'progress', id, loaded, total })
      })
      // Load the freshly downloaded model on the next refine.
      return invalidateMattingSession()
    case 'invalidate':
      switch (job.model) {
        case 'isnet':
          return invalidateIsnetSession()
        case 'inpaint':
          return invalidateInpaintSession()
        case 'matting':
          return invalidateMattingSession()
        case 'upscale':
          return invalidateUpscaleSession(job.modelId)
      }
  }
}

port.on('message', (event: { data: HostMessage }) => {
  const msg = event.data
  if (msg.type === 'init') {
    setMlPaths(msg.paths)
    return
  }
  run(msg.id, msg.job).then(
    (result) => post({ type: 'result', id: msg.id, result }),
    (err: unknown) =>
      post({
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      }),
  )
})
