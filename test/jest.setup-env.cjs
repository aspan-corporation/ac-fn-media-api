/**
 * Sets the environment variables handlers read at module-load time.
 *
 * Under the ESM test setup, `import` statements are hoisted and evaluated
 * before a test file's top-level `process.env.X = ...` statements run, so
 * handlers that call assertEnvVar() at module scope would throw before the
 * test body executes. A `setupFiles` entry runs before the test module (and
 * its imports) are evaluated, so the env is in place in time.
 */
process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";
process.env.AC_TAU_MEDIA_SEARCH_TABLE_NAME = "test-search";
process.env.AC_TAGS_TABLE_NAME = "test-tags";
process.env.AC_ALBUMS_TABLE_NAME = "test-albums";
process.env.AC_TAU_MEDIA_MEDIA_BUCKET_NAME = "test-media-bucket";
process.env.AC_TAU_MEDIA_MEDIA_BUCKET_ACCESS_ROLE_ARN =
  "arn:aws:iam::111122223333:role/test-media-read";
process.env.AC_DIARY_BUCKET_NAME = "test-diary-bucket";
process.env.AC_META_QUEUE_URL = "https://sqs.test/meta";
process.env.AC_RESIZER_QUEUE_URL = "https://sqs.test/resizer";
process.env.AC_VIDEO_META_QUEUE_URL = "https://sqs.test/video-meta";
process.env.AC_VIDEO_ENCODER_QUEUE_URL = "https://sqs.test/video-encoder";
process.env.AC_VIDEO_THUMBS_QUEUE_URL = "https://sqs.test/video-thumbs";
