const typeClasses = [
  'ransom-letter--chalk',
  'ransom-letter--cartoon',
  'ransom-letter--cute',
  'ransom-letter--koala',
  'ransom-letter--chalk',
  'ransom-letter--cartoon',
] as const;

export function RansomTitle({ text, size = 'hero' }: { text: string; size?: 'hero' | 'section' }) {
  let letterIndex = 0;

  return (
    <span className={`ransom-title ransom-title--${size}`}>
      <span className="visually-hidden">{text}</span>
      <span className="ransom-title__art" aria-hidden="true">
        {text
          .toUpperCase()
          .split(' ')
          .map((word, wordIndex) => (
            <span className="ransom-title__word" key={`${word}-${wordIndex}`}>
              {Array.from(word).map((letter) => {
                const style = typeClasses[letterIndex % typeClasses.length];
                const key = `${wordIndex}-${letterIndex}-${letter}`;
                letterIndex += 1;
                return (
                  <span className={`ransom-letter ${style}`} key={key}>
                    {letter}
                  </span>
                );
              })}
            </span>
          ))}
      </span>
    </span>
  );
}
