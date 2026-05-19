import { AcContext, MetricUnit, S3Service } from "@aspan-corporation/ac-shared";
import {
  DIM_THUMBNAIL_HEIGHT,
  DIM_THUMBNAIL_WIDTH,
  getThumbnailKey
} from "@aspan-corporation/ac-shared/utils";
import { spawn } from "child_process";

const FFMPEG_PATH = "/opt/bin/ffmpeg";
const FFPROBE_PATH = "/opt/bin/ffprobe";

const detectRotation = async (signedUrl: string): Promise<number> => {
  const ffprobe = spawn(FFPROBE_PATH, [
    "-i", signedUrl,
    "-select_streams", "v:0",
    "-show_entries", "stream_side_data=rotation",
    "-v", "quiet",
    "-of", "csv=p=0",
  ], { timeout: 30000 });
  return new Promise((resolve) => {
    let out = "";
    ffprobe.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    ffprobe.on("close", () => {
      const angle = parseInt(out.trim(), 10);
      resolve(isNaN(angle) ? 0 : ((angle % 360) + 360) % 360);
    });
    ffprobe.on("error", () => resolve(0));
  });
};
type EncodeVideoParams = {
  sourceS3Service: S3Service;
  sourceBucket: string;
  sourceKey: string;
  destinationS3Service: S3Service;
  destinationBucket: string;
};

/**
 * Extracts a thumbnail from a video using FFmpeg and uploads it to S3. Output is always in WebP format.
 */
export const makeThumbnail = async (
  {
    sourceBucket,
    sourceKey,
    destinationBucket,
    destinationS3Service,
    sourceS3Service
  }: EncodeVideoParams,
  { logger, metrics }: AcContext
) => {
  if (!Number.isInteger(DIM_THUMBNAIL_WIDTH) || DIM_THUMBNAIL_WIDTH <= 0 ||
      !Number.isInteger(DIM_THUMBNAIL_HEIGHT) || DIM_THUMBNAIL_HEIGHT <= 0) {
    throw new Error(`Invalid thumbnail dimensions: ${DIM_THUMBNAIL_WIDTH}x${DIM_THUMBNAIL_HEIGHT}`);
  }

  logger.debug("MakeThumbnailsStarted", { sourceKey });
  metrics.addMetric("MakeThumbnailsStarted", MetricUnit.Count, 1);

  const destinationKey = getThumbnailKey({
    key: sourceKey,
    width: DIM_THUMBNAIL_WIDTH,
    height: DIM_THUMBNAIL_HEIGHT
  });

  const { stream, done } = destinationS3Service.createS3UploadStream({
    Bucket: destinationBucket,
    Key: destinationKey
  });

  const signedSourceUrl = await sourceS3Service.getSignedUrl({
    Bucket: sourceBucket,
    Key: sourceKey
  });

  const rotation = await detectRotation(signedSourceUrl);
  const rotateFilter = rotation === 90  ? "transpose=1,"
                     : rotation === 180 ? "transpose=1,transpose=1,"
                     : rotation === 270 ? "transpose=2,"
                     : "";

  // Filter chain explained:
  //   scale=W:H:force_original_aspect_ratio=decrease
  //     Shrink the frame so it fits *entirely* inside WxH while keeping the
  //     original aspect ratio. Previously this used `increase,crop=W:H` which
  //     cropped the edges to fill the box — same problem as the image path.
  //   pad=W:H:(W-iw)/2:(H-ih)/2:color=black@0
  //     Centre the scaled frame on a WxH canvas and fill the leftover bars
  //     with fully transparent pixels (`black@0` = alpha 0). Matches the
  //     image thumbnails, which also use transparent letterboxing.
  //   format=yuva420p
  //     Promote the pixel format to one that carries an alpha channel; without
  //     this the pad filter's transparent fill would collapse to opaque black
  //     because the source video is yuv420p with no alpha plane. yuva420p is
  //     the alpha variant of yuv420p and is what libwebp expects for
  //     transparent WebP output.
  const ffmpeg = spawn(FFMPEG_PATH, [
    "-i",
    signedSourceUrl,
    "-vf",
    `${rotateFilter}scale=${DIM_THUMBNAIL_WIDTH}:${
      DIM_THUMBNAIL_HEIGHT
    }:force_original_aspect_ratio=decrease,pad=${DIM_THUMBNAIL_WIDTH}:${
      DIM_THUMBNAIL_HEIGHT
    }:(${DIM_THUMBNAIL_WIDTH}-iw)/2:(${DIM_THUMBNAIL_HEIGHT}-ih)/2:color=black@0,format=yuva420p`,
    "-frames:v",
    "1",
    "-c:v",
    "libwebp",
    "-quality",
    "80",
    "-f",
    "webp",
    "pipe:1"
  ], { timeout: 270000 });

  ffmpeg.stdout.pipe(stream);

  ffmpeg.stderr.on("data", (d) => {
    if (!d.toString().includes("frame=")) logger.debug(d.toString());
  });

  const exitCode = await new Promise((resolve, reject) => {
    let settled = false;
    ffmpeg.on("close", (code) => {
      if (!settled) { settled = true; resolve(code); }
    });
    ffmpeg.on("error", (err) => {
      if (!settled) { settled = true; reject(err); }
    });
  });

  if (exitCode !== 0) {
    throw new Error(`FFmpeg failed with code ${exitCode}`);
  }

  await done;

  logger.debug("MakeThumbnailsFinished", {
    exitCode,
    sourceKey
  });
  metrics.addMetric("MakeThumbnailsFinished", MetricUnit.Count, 1);

  logger.debug("uploaded encoded video", { sourceKey, destinationKey });
};
