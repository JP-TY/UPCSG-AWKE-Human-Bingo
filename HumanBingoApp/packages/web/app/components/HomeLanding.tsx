import Image from 'next/image';
import Link from 'next/link';
import { RansomTitle } from './RansomTitle';
import { ResumeLastGame } from './ResumeLastGame';

const playSteps = [
  {
    title: 'Get your card',
    text: 'Join with the six-character code from your host.',
  },
  {
    title: 'Find your person',
    text: 'A square is a reason to start a conversation.',
  },
  {
    title: 'Ask for a stamp',
    text: 'Enter their Player Code and let them confirm it.',
  },
  {
    title: 'Make a line',
    text: 'Every confirmed square brings your board closer.',
  },
];

export function HomeLanding() {
  return (
    <>
      <section className="marquee-hero gingham-field" aria-labelledby="home-title">
        <figure className="hero-photo page-wrap">
          <Image
            className="hero-photo__image"
            src="/brand/hero-section.webp"
            alt="AKWE 2026 scrapbook board with cork, colorful cutout lettering, stickers, crayons, and red gingham"
            width={1080}
            height={608}
            sizes="100vw"
            priority
          />
          <figcaption className="hero-photo__caption">
            <p className="hero-photo__event">AKWE 2026 · CEBU</p>
            <h1 id="home-title">
              <RansomTitle text="Human Bingo" />
            </h1>
          </figcaption>
        </figure>
      </section>

      <hr className="hero-rule" />

      <div className="page-wrap home-content">
        <ResumeLastGame />

        <section className="steps-section" aria-labelledby="how-to-play-title">
          <div className="section-heading">
            <div>
              <span className="section-mark">THE GAME, IN FOUR BEATS</span>
              <h2 id="how-to-play-title">Talk first. Stamp later.</h2>
            </div>
            <span className="biro-note" aria-hidden="true">
              no awkward icebreaker script
            </span>
          </div>
          <ol className="steps-list">
            {playSteps.map((step, index) => (
              <li key={step.title}>
                <span className="step-number">0{index + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="event-art-section" aria-labelledby="event-art-title">
          <div className="event-art-section__copy">
            <span className="section-mark">CUT, PASTE, MEET</span>
            <h2 id="event-art-title">Made for this room.</h2>
            <p>
              Bring your card into the conversation. Every face-stamp marks a real yes from someone
              you met here.
            </p>
          </div>
          <figure className="artifact-photo">
            <Image
              src="/brand/header-paper.webp"
              alt="AKWE 2026 cutout title laid on torn paper"
              width={1800}
              height={340}
              sizes="(max-width: 60rem) 100vw, 52vw"
            />
            <figcaption>AKWE 2026, built from the event kit.</figcaption>
          </figure>
        </section>

        <section className="entry-section" aria-labelledby="entry-title">
          <div>
            <span className="section-mark section-mark--light">PICK UP A PENCIL</span>
            <h2 id="entry-title">Ready to meet someone new?</h2>
            <p>Join a card your host already made, or set one up for your group.</p>
          </div>
          <div className="entry-section__actions">
            <Link className="action-link action-link--primary" href="/join">
              Join a game
            </Link>
            <Link className="action-link action-link--quiet" href="/host">
              Host a game
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
