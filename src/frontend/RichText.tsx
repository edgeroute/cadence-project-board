import React from 'react';
import { Markdown } from './Markdown';
import { extractImages, stripImages } from './imageUtils';

/**
 * A body of GitHub markdown as it should appear here: prose rendered, images pulled
 * out into thumbnails, and a lightbox behind them.
 *
 * The pairing of `stripImages` before `Markdown` and `extractImages` beside it is a
 * contract rather than a coincidence — `Markdown` renders no images at all, so text
 * that skipped the strip would show raw `![alt](url)` syntax. Putting both halves in
 * one component is what stops the next caller getting that wrong. Both the issue body
 * and every comment go through here.
 *
 * The lightbox is ported from szmidtpiotr/claude-github-issue (MIT) — see LICENSE.
 */

const Lightbox: React.FC<{ src: string; alt: string; onClose: () => void }> = ({ src, alt, onClose }) => {
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    setFailed(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The item modal is also listening for Escape. Without this the first press
        // would close the lightbox *and* the modal behind it, losing the reader's
        // place because they wanted to dismiss a picture.
        e.stopPropagation();
        onClose();
      }
    };
    // Capture, so this runs before the modal's own document-level listener.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, src]);

  return (
    <div className="cpb-lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label={alt || 'Image'}>
      <button className="cpb-lightbox-close" onClick={onClose} aria-label="Close image">✕</button>
      {failed ? (
        <div className="cpb-lightbox-error" onClick={(e) => e.stopPropagation()}>
          <div>This image could not be loaded.</div>
          {/* Private-repo attachments are served behind a session cookie this panel
              does not have, so a failure here is expected rather than exceptional —
              and the original URL is the way through it. */}
          <a href={src} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            Open the original ↗
          </a>
        </div>
      ) : (
        <img
          className="cpb-lightbox-img"
          src={src}
          alt={alt}
          onClick={(e) => e.stopPropagation()}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
};

export const RichText: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const images = React.useMemo(() => extractImages(text), [text]);
  const prose = React.useMemo(() => stripImages(text), [text]);
  const [open, setOpen] = React.useState<{ src: string; alt: string } | null>(null);

  return (
    <>
      {prose && <Markdown text={prose} className={className} />}
      {images.length > 0 && (
        <div className="cpb-thumbs">
          {images.map((img) => (
            <button
              key={img.url}
              className="cpb-thumb"
              onClick={() => setOpen({ src: img.url, alt: img.alt })}
              title={img.alt || 'Open image'}
            >
              <img src={img.url} alt={img.alt} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {open && <Lightbox src={open.src} alt={open.alt} onClose={() => setOpen(null)} />}
    </>
  );
};
