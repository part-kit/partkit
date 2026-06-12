/**
 * Known-answer vectors captured from the AWS CLI (botocore) — the canonical
 * SigV4 implementation — on 2026-06-11, using AWS's documented example
 * credentials. Each is a presigned GET URL (the CLI only presigns GET); they
 * anchor the part's signing to AWS's own output byte-for-byte. The PUT/upload
 * path, which the CLI cannot presign, is validated against reference-sigv4.ts,
 * which these same vectors prove correct.
 *
 * To regenerate:
 *   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
 *   aws s3 presign s3://<bucket>/<key> --endpoint-url <ep> --region <r> --expires-in <n>
 */
export const ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
export const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

export interface KnownAnswer {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  forcePathStyle: boolean;
  expiresInSeconds: number;
  amzDate: string; // pinned: the X-Amz-Date botocore used
  signature: string;
  url: string;
}

export const VECTORS: KnownAnswer[] = [
  {
    name: "path-style, simple key, us-east-1",
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "example-bucket",
    key: "path/to/object.txt",
    forcePathStyle: true,
    expiresInSeconds: 3600,
    amzDate: "20260611T174745Z",
    signature: "faf5693a8df8f7b753be504071717fcbb30a81c36c8a1a147520138a46a9c394",
    url: "https://s3.example.com/example-bucket/path/to/object.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260611%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260611T174745Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=faf5693a8df8f7b753be504071717fcbb30a81c36c8a1a147520138a46a9c394",
  },
  {
    name: "path-style, key with space + unicode + parens",
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "example-bucket",
    key: "uploads/My Photo (Æ).jpg",
    forcePathStyle: true,
    expiresInSeconds: 600,
    amzDate: "20260611T174912Z",
    signature: "a869eb4f4ac86367425438248bef510cfe51094eab53ce360a16343d7e5008f7",
    url: "https://s3.example.com/example-bucket/uploads/My%20Photo%20%28%C3%86%29.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260611%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260611T174912Z&X-Amz-Expires=600&X-Amz-SignedHeaders=host&X-Amz-Signature=a869eb4f4ac86367425438248bef510cfe51094eab53ce360a16343d7e5008f7",
  },
  {
    name: "virtual-hosted, simple key, us-east-1",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    bucket: "example-bucket",
    key: "path/to/object.txt",
    forcePathStyle: false,
    expiresInSeconds: 3600,
    amzDate: "20260611T174913Z",
    signature: "b25ffde5dc1b94c70e4471c8a7123e0e1eda6b4a46e277995e10eed7f1fd24ed",
    url: "https://example-bucket.s3.us-east-1.amazonaws.com/path/to/object.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260611%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260611T174913Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=b25ffde5dc1b94c70e4471c8a7123e0e1eda6b4a46e277995e10eed7f1fd24ed",
  },
  {
    name: "path-style, non-default port, eu-central-1, nested key",
    endpoint: "https://minio.local:9000",
    region: "eu-central-1",
    bucket: "my-bucket",
    key: "a/b/c/data.bin",
    forcePathStyle: true,
    expiresInSeconds: 86400,
    amzDate: "20260611T174913Z",
    signature: "6889fa66b695a8561e013178ec73c61a7740167de6eda052064558471ad0911b",
    url: "https://minio.local:9000/my-bucket/a/b/c/data.bin?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260611%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20260611T174913Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=6889fa66b695a8561e013178ec73c61a7740167de6eda052064558471ad0911b",
  },
];

/** "20260611T174745Z" → epoch ms, for vi.setSystemTime. */
export function amzDateToMs(amzDate: string): number {
  const iso = `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(
    9,
    11,
  )}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`;
  return new Date(iso).getTime();
}
