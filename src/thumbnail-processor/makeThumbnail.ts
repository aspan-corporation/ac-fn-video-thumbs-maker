import { AcContext, MetricUnit, S3Service } from "@aspan-corporation/ac-shared";
import {
  DIM_THUMBNAIL_HEIGHT,
  DIM_THUMBNAIL_WIDTH,
  getThumbnailKey
} from "@aspan-corporation/ac-shared/utils";
import { spawn } from "child_process";

const FFMPEG_PATH = "/opt/bin/ffmpeg";
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

  const ffmpeg = spawn(FFMPEG_PATH, [
    "-i",
    signedSourceUrl,
    "-vf",
    `scale=${DIM_THUMBNAIL_WIDTH}:${
      DIM_THUMBNAIL_HEIGHT
    }:force_original_aspect_ratio=increase,crop=${DIM_THUMBNAIL_WIDTH}:${DIM_THUMBNAIL_HEIGHT}`,
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
