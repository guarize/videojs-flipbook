import { MEDIA } from '../site/media';

/**
 * Someone else's page (host.html): the player arrives through the drop-in call, with nothing of this repo's pages
 * around it. `?noskin` leaves the page alone, so the leak check can read it before and after the skin's CSS.
 */
const params = new URLSearchParams(location.search);
const host = document.getElementById('player');

if (host && !params.has('noskin')) {
  const { mountFlipbook } = await import('@/skins/flipbook/standalone');
  const features = params.get('features');
  mountFlipbook(
    host,
    { title: MEDIA.title, poster: MEDIA.poster, src: MEDIA.mp4, chapters: MEDIA.chapters, captions: MEDIA.captions, storyboard: MEDIA.storyboard },
    features ? { features: (features === 'essential' || features === 'book' ? features : features.split(/\s+/).filter(Boolean)) as never } : {},
  );
}

// The host's stylesheet after the skin's: source order must not decide who wins.
if (params.get('host') === 'hostile' && params.has('late')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './host/hostile.css';
  await new Promise((resolve) => {
    link.addEventListener('load', resolve, { once: true });
    document.head.append(link);
  });
}

document.documentElement.dataset.hostReady = '';
