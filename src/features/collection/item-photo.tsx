'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { api, errorMessage } from '@/lib/api';
import { uploadPhoto } from '@/lib/photo-upload';
import { photoFileError, photoImportInput, type PhotoCover, type PhotoUpload } from '@/shared/photos';
import { getSubmissionAttempt, type SubmissionAttempt } from '@/shared/submission';
import { PhotoCoverImage } from '@/components/photo-cover';

type Selection = { file: File; url: string; expectedCoverId: string | null };
export function ItemPhoto({ itemId, name, category, cover, pending, refresh }: {
  itemId: string; name: string; category: string; cover: PhotoCover | null; pending: PhotoUpload | null; refresh: () => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [link, setLink] = useState<{ url: string; expectedCoverId: string | null } | null>(null);
  const [stage, setStage] = useState('');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reservation = useRef<SubmissionAttempt | null>(null);
  const completion = useRef<SubmissionAttempt | null>(null);
  const removal = useRef<SubmissionAttempt | null>(null);
  const importing = useRef<SubmissionAttempt | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { return () => { if (selection) URL.revokeObjectURL(selection.url); }; }, [selection]);
  function select(file?: File) {
    if (!file) return;
    setError(''); setNotice('');
    const invalid = photoFileError(file);
    if (invalid) { setError(invalid); return; }
    reservation.current = null; completion.current = null;
    importing.current = null; setLink(null);
    setSelection({ file, url: URL.createObjectURL(file), expectedCoverId: cover?.id ?? null });
  }
  async function saveLink() {
    if (!link || stage) return;
    const parsed = photoImportInput.safeParse(link);
    if (!parsed.success) { setError('Enter a direct HTTPS image link without credentials, fragments, or a custom port.'); return; }
    const active = new AbortController(); controller.current = active;
    setError(''); setNotice(''); setStage('Downloading and checking image…');
    try {
      const path = `/items/${itemId}/photo/imports`, body = JSON.stringify(parsed.data);
      importing.current = getSubmissionAttempt(importing.current, path, body);
      const result = await api<{ upload: PhotoUpload }>(path, { method: 'POST', body, signal: active.signal, headers: { 'Idempotency-Key': importing.current.key } });
      if (!mounted.current || active.signal.aborted) return;
      setStage('Saving photo…');
      const completePath = `/items/${itemId}/photo/uploads/${result.upload.id}/complete`;
      completion.current = getSubmissionAttempt(completion.current, completePath, '{}');
      await api(completePath, { method: 'POST', body: '{}', signal: active.signal, headers: { 'Idempotency-Key': completion.current.key } });
      if (!mounted.current || active.signal.aborted) return;
      importing.current = null; completion.current = null; removal.current = null;
      setLink(null); setNotice('Photo saved.'); refresh();
      window.dispatchEvent(new Event('inventory:photos-changed'));
    } catch (err) { if (mounted.current && !active.signal.aborted) setError(errorMessage(err)); }
    finally { if (mounted.current) setStage(''); }
  }
  async function save() {
    if (!selection || stage) return;
    const active = new AbortController(); controller.current = active;
    setError(''); setNotice(''); setPercent(0); setStage('Preparing photo…');
    try {
      const bytes = await selection.file.arrayBuffer();
      const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      if (!mounted.current || active.signal.aborted) return;
      const path = `/items/${itemId}/photo/uploads`;
      const body = JSON.stringify({ byteSize: selection.file.size, mimeType: selection.file.type, checksum, expectedCoverId: selection.expectedCoverId });
      reservation.current = getSubmissionAttempt(reservation.current, path, body);
      const result = await api<{ upload: PhotoUpload }>(path, { method: 'POST', body, signal: active.signal, headers: { 'Idempotency-Key': reservation.current.key } });
      if (!mounted.current || active.signal.aborted) return;
      setStage('Uploading photo…');
      let uploadError: unknown;
      try { await uploadPhoto(selection.file, result.upload.storagePath, active.signal, value => { if (mounted.current) setPercent(value); }); }
      catch (err) { uploadError = err; }
      if (!mounted.current || active.signal.aborted) return;
      // A timeout or existing-object response can follow a successful Storage write.
      // Completion verifies the checksum before using those bytes.
      setStage('Checking and saving photo…');
      const completePath = `${path}/${result.upload.id}/complete`;
      completion.current = getSubmissionAttempt(completion.current, completePath, '{}');
      try { await api(completePath, { method: 'POST', body: '{}', signal: active.signal, headers: { 'Idempotency-Key': completion.current.key } }); }
      catch (err) { throw new Error(uploadError ? `${errorMessage(uploadError)} ${errorMessage(err)}` : errorMessage(err)); }
      if (!mounted.current) return;
      reservation.current = null; completion.current = null; removal.current = null;
      setSelection(null); setNotice('Photo saved.'); refresh();
      window.dispatchEvent(new Event('inventory:photos-changed'));
    } catch (err) { if (mounted.current && !active.signal.aborted) setError(errorMessage(err)); }
    finally { if (mounted.current) setStage(''); }
  }
  async function remove() {
    if (!cover || stage) return;
    const active = new AbortController(); controller.current = active;
    setError(''); setNotice(''); setStage('Removing photo…');
    try {
      const path = `/items/${itemId}/photo`, body = JSON.stringify({ expectedCoverId: cover.id });
      removal.current = getSubmissionAttempt(removal.current, path, body);
      await api(path, { method: 'DELETE', body, signal: active.signal, headers: { 'Idempotency-Key': removal.current.key } });
      if (!mounted.current) return;
      removal.current = null; importing.current = null; setSelection(null); setLink(null); setNotice('Photo removed.'); refresh();
      window.dispatchEvent(new Event('inventory:photos-changed'));
    } catch (err) { if (mounted.current && !active.signal.aborted) setError(errorMessage(err)); }
    finally { if (mounted.current) setStage(''); }
  }
  return <section className="item-photo-section" aria-label="Item photo">
    <h2>Photo</h2>
    <div className="item-photo-cover"><PhotoCoverImage cover={cover} category={category} name={name} refresh={refresh} /></div>
    <p className="muted">One private cover photo. JPEG, PNG, or static WebP, up to 5 MB.</p>
    {pending && !selection && <p className="muted">An upload is waiting. Select the same file to resume, or choose a different photo.</p>}
    <input ref={picker} className="photo-file-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose item photo" disabled={!!stage}
      onChange={event => { select(event.target.files?.[0]); event.target.value = ''; }} />
    {selection && <div className="photo-local-preview"><div className="photo-preview-frame"><Image unoptimized src={selection.url} alt="Selected photo preview" fill sizes="240px" style={{ objectFit: "contain" }} /></div><p>{selection.file.name}</p></div>}
    {link && <form className="photo-link-form" onSubmit={event => { event.preventDefault(); void saveLink(); }}>
      <label htmlFor={`photo-link-${itemId}`}>Direct image link</label>
      <input id={`photo-link-${itemId}`} type="url" value={link.url} placeholder="https://example.com/photo.jpg" maxLength={2048} required disabled={!!stage}
        onChange={event => { importing.current = null; completion.current = null; setError(''); setLink({ ...link, url: event.target.value }); }} />
      <p className="muted">Use a public HTTPS link to the image itself. Webpages, sharing links, and redirects are not supported. Import saves a private copy.</p>
      <div className="photo-actions"><button type="submit" className="button primary" disabled={!!stage || !link.url.trim()}>{error ? 'Retry import' : 'Import photo'}</button>
        <button type="button" className="text-button" disabled={!!stage} onClick={() => { importing.current = null; completion.current = null; setLink(null); setError(''); }}>Cancel link</button></div>
    </form>}
    {error && <p className="photo-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {stage && <div role="status"><p>{stage}</p>{stage === 'Uploading photo…' && <progress aria-label="Photo upload progress" max={100} value={percent} />}</div>}
    <div className="photo-actions">
      <button type="button" className="button secondary" disabled={!!stage} onClick={() => picker.current?.click()}>{cover ? 'Replace photo' : 'Add photo'}</button>
      {!link && <button type="button" className="button secondary" disabled={!!stage} onClick={() => {
        reservation.current = null; importing.current = null; completion.current = null; setSelection(null); setError(''); setNotice('');
        setLink({ url: '', expectedCoverId: cover?.id ?? null });
      }}>Paste image link</button>}
      {selection && <><button type="button" className="button primary" disabled={!!stage} onClick={save}>{error ? 'Retry upload' : 'Upload'}</button><button type="button" className="text-button" disabled={!!stage} onClick={() => { setSelection(null); setError(''); }}>Cancel selection</button></>}
      {cover && <button type="button" className="text-button" disabled={!!stage} onClick={remove}>Remove photo</button>}
      {cover && !cover.url && <button type="button" className="text-button" disabled={!!stage} onClick={refresh}>Reload photo</button>}
    </div>
  </section>;
}
