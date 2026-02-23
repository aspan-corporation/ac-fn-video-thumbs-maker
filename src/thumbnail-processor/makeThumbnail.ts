import { AcContext, MetricUnit, S3Service } from "@aspan-corporation/ac-shared";
import {
  DIM_THUMBNAIL_WIDTH,
  DIM_DETAIL_HEIGHT,
  getThumbnailKey,
  DIM_THUMBNAIL_HEIGHT
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
 * Resizes an image and uploads it to S3. Output is always in JPEG format.
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
  logger.debug("MakeThumbnailsStarted", { sourceKey });
  metrics.addMetric("MakeThumbnailsStarted", MetricUnit.Count, 1);

  const destinationKey = getThumbnailKey({
    key: sourceKey,
    width: DIM_THUMBNAIL_WIDTH,
    height: DIM_DETAIL_HEIGHT
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
  ]);

  ffmpeg.stdout.pipe(stream);

  ffmpeg.stderr.on("data", (d) => {
    // !d.toString().includes("frame=") && logger.info(d.toString());
  });

  const exitCode = await new Promise((resolve, reject) => {
    ffmpeg.on("close", resolve);
    ffmpeg.on("error", reject);
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
