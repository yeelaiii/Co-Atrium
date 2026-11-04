import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

export type Bucket = 'attachments' | 'audio';

// Signed URLs for private storage objects. Kept short-lived (storage migration 0007), cached
// until shortly before expiry, and requested in one batch per bucket per tick so a list of
// photos costs one round trip. Images also pass the storage path as expo-image's cacheKey, so
// a fresh URL for the same photo is still served from disk.
const EXPIRES_IN = 600;
const cache = new Map<string, { url: string; expires: number }>();
const queued = new Map<Bucket, Map<string, ((url: string | null) => void)[]>>();

function flush(bucket: Bucket) {
  const waiting = queued.get(bucket);
  queued.delete(bucket);
  if (!waiting?.size) return;
  const paths = [...waiting.keys()];
  supabase.storage
    .from(bucket)
    .createSignedUrls(paths, EXPIRES_IN)
    .then(({ data }) => {
      const byPath = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
      for (const path of paths) {
        const url = byPath.get(path) ?? null;
        if (url) cache.set(`${bucket}/${path}`, { url, expires: Date.now() + (EXPIRES_IN - 60) * 1000 });
        waiting.get(path)!.forEach((resolve) => resolve(url));
      }
    })
    .catch(() => waiting.forEach((resolvers) => resolvers.forEach((resolve) => resolve(null))));
}

export function getSignedUrl(bucket: Bucket, path: string): Promise<string | null> {
  const hit = cache.get(`${bucket}/${path}`);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.url);
  return new Promise((resolve) => {
    let forBucket = queued.get(bucket);
    if (!forBucket) {
      forBucket = new Map();
      queued.set(bucket, forBucket);
      setTimeout(() => flush(bucket), 0);
    }
    forBucket.set(path, [...(forBucket.get(path) ?? []), resolve]);
  });
}

/** Signed URL for one object, or null while loading / if it can't be read. */
export function useSignedUrl(bucket: Bucket, path: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(() => {
    const hit = path ? cache.get(`${bucket}/${path}`) : undefined;
    return hit && hit.expires > Date.now() ? hit.url : null;
  });

  useEffect(() => {
    if (!path) return;
    let live = true;
    getSignedUrl(bucket, path).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [bucket, path]);

  return path ? url : null;
}
