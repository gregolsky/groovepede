import { serviceListText } from './services.js';

/**
 * The empty-queue landing page: hero, feature cards, extras and the
 * how-it-works timeline. Static marketing copy, kept apart from the app's
 * views in render.js; the only live parts are the service list and
 * `addSection`, the add form or its call-to-action button, which render.js
 * builds (it also appears in the populated queue's toolbar).
 */
export function renderLanding(addSection) {
  return `
    <div class="landing">
      <div class="landing-hero">
        <div class="landing-hero-text">
          <h2 class="landing-headline">Never lose a great album<br>recommendation again.</h2>
          <p class="landing-sub">Paste a link from any streaming service, explore by genre, and check albums off as you listen.</p>
          ${addSection}
          <p class="landing-hero-faq"><a href="faq.html" class="landing-hero-faq-link">Frequently asked questions →</a></p>
        </div>
        <div class="landing-hero-visual">
          <div class="landing-logo-wrap">
            <div class="landing-logo-rings"></div>
            <img class="landing-logo" src="img/logo.webp" alt="Groovepede">
          </div>
        </div>
      </div>

      <div class="landing-features">
        <div class="landing-feature">
          <div class="landing-feature-img-wrap">
            <img class="landing-feature-img" src="img/feature-save.webp" width="1081" height="808" alt="" decoding="async" loading="lazy">
            <div class="landing-feature-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0FD287" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                <polyline points="16 6 12 2 8 6"/>
                <line x1="12" y1="2" x2="12" y2="15"/>
              </svg>
            </div>
          </div>
          <div class="landing-feature-body">
            <h3>Save from anywhere</h3>
            <p>Paste links from ${serviceListText()}. Or share directly from your phone's music app.</p>
          </div>
        </div>
        <div class="landing-feature">
          <div class="landing-feature-img-wrap">
            <img class="landing-feature-img" src="img/feature-genres.webp" width="1081" height="808" alt="" decoding="async" loading="lazy">
            <div class="landing-feature-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0FD287" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                <line x1="7" y1="7" x2="7.01" y2="7"/>
              </svg>
            </div>
          </div>
          <div class="landing-feature-body">
            <h3>Auto-tagged genres</h3>
            <p>Every album is enriched with genre tags from Last.fm. Filter your queue by mood or style at a glance.</p>
          </div>
        </div>
        <div class="landing-feature">
          <div class="landing-feature-img-wrap">
            <img class="landing-feature-img" src="img/feature-local.webp" width="1081" height="808" alt="" decoding="async" loading="lazy">
            <div class="landing-feature-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0FD287" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </div>
          </div>
          <div class="landing-feature-body">
            <h3>Fully local</h3>
            <p>Your queue lives in your browser's storage. Nothing is sent to our servers &mdash; because there are none.</p>
          </div>
        </div>
      </div>

      <div class="landing-extras">
        <div class="landing-extra">
          <h4>Dig into an artist</h4>
          <p>Tap any album for its tracklist, the artist's bio, and similar artists worth queueing next.</p>
        </div>
        <div class="landing-extra">
          <h4>Take your queue with you</h4>
          <p>Export the whole queue as a JSON file and import it anywhere. It's your data, in a format you can read.</p>
        </div>
        <div class="landing-extra">
          <h4>Install it like an app</h4>
          <p>Add Groovepede to your home screen. On Android it shows up in the share sheet of your music apps.</p>
        </div>
      </div>

      <div class="landing-steps">
        <h3 class="landing-section-title">How it works</h3>
        <div class="landing-timeline">
          <div class="landing-timeline-step">
            <div class="landing-timeline-num">1</div>
            <img class="landing-timeline-img" src="img/step-paste.webp" width="1081" height="808" alt="" decoding="async" loading="lazy">
            <strong class="landing-timeline-title">Paste a link</strong>
            <p class="landing-timeline-caption">Copy an album URL from any supported service and paste it in. Or share directly from your phone's music app.</p>
          </div>
          <div class="landing-timeline-step">
            <div class="landing-timeline-num">2</div>
            <img class="landing-timeline-img" src="img/step-service.webp" width="1081" height="808" alt="" decoding="async" loading="lazy">
            <strong class="landing-timeline-title">Pick your service</strong>
            <p class="landing-timeline-caption">Set your preferred streaming service in the profile so the Listen button always opens in the right app.</p>
          </div>
          <div class="landing-timeline-step">
            <div class="landing-timeline-num">3</div>
            <img class="landing-timeline-img" src="img/step-listen.webp" width="1081" height="808" alt="" decoding="async" loading="lazy">
            <strong class="landing-timeline-title">Listen. Done. Repeat.</strong>
            <p class="landing-timeline-caption">When you're ready, tap Listen. Tap Done when finished to track your progress.</p>
          </div>
        </div>
      </div>

    </div>`;
}
