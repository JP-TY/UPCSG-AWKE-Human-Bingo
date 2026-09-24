import localFont from 'next/font/local';

export const chalktastic = localFont({
  src: './fonts/Chalktastic.ttf',
  display: 'swap',
  variable: '--font-chalktastic',
});

export const cartoon2us = localFont({
  src: './fonts/Cartoon2US-Regular.woff2',
  display: 'swap',
  variable: '--font-cartoon2us',
});

export const cuteTumblr = localFont({
  src: './fonts/CuteTumblrFont.ttf',
  display: 'swap',
  variable: '--font-cute-tumblr',
});

export const biroScript = localFont({
  src: './fonts/Biro_Script_reduced.ttf',
  display: 'swap',
  variable: '--font-biro-script',
});

export const koalaStation = localFont({
  src: './fonts/KoalaStation.ttf',
  display: 'swap',
  variable: '--font-koala-station',
});

export const eventFontVariables = [
  chalktastic.variable,
  cartoon2us.variable,
  cuteTumblr.variable,
  biroScript.variable,
  koalaStation.variable,
].join(' ');
