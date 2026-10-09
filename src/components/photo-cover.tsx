'use client';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import type { PhotoCover } from '@/shared/photos';
import { CategoryArtwork } from './category-artwork';
export function PhotoCoverImage({ cover, category, name, refresh }: { cover: PhotoCover | null; category: string; name: string; refresh: () => void }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const retried = useRef<string | null>(null);
  useEffect(() => {
    if (!cover?.url) return;
    const remaining = Math.max(0, new Date(cover.expiresAt).valueOf() - Date.now());
    const timer = setTimeout(refresh, remaining + 1000);
    const visible = () => { if (document.visibilityState === 'visible' && Date.now() >= new Date(cover.expiresAt).valueOf()) refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [cover?.url, cover?.expiresAt, refresh]);
  if (!cover?.url || failedUrl === cover.url) return <CategoryArtwork category={category} />;
  return <Image unoptimized className="item-cover-image" src={cover.url} alt={`${name} cover photo`} width={cover.width} height={cover.height}
    onError={() => { setFailedUrl(cover.url); if (retried.current !== cover.id) { retried.current = cover.id; refresh(); } }} />;
}
