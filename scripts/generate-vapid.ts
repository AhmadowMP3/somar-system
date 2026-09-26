/**
 * npm run generate:vapid                       → prints a fresh pair (local use)
 * npm run generate:vapid -- --write <envfile>  → writes the pair into the env file, prints only the public key.
 * Refuses to overwrite existing keys: rotating them invalidates every push subscription.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import webpush from 'web-push';

const argv = process.argv.slice(2);
const target = argv.includes('--write') ? argv[argv.indexOf('--write') + 1] : undefined;
const keys = webpush.generateVAPIDKeys();

if (!target) {
  console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
  console.log(`VITE_VAPID_PUBLIC_KEY=${keys.publicKey}`);
} else {
  let text = readFileSync(target, 'utf8');
  const current = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
  if (current('VAPID_PUBLIC_KEY') || current('VAPID_PRIVATE_KEY')) {
    console.error('مفاتيح VAPID موجودة مسبقاً في الملف — لن تُستبدل (استبدالها يُبطل كل اشتراكات الإشعارات).');
    process.exitCode = 1;
  } else {
    const set = (name: string, value: string) => {
      const re = new RegExp(`^${name}=.*$`, 'm');
      text = re.test(text) ? text.replace(re, `${name}=${value}`) : `${text.trimEnd()}\n${name}=${value}\n`;
    };
    set('VAPID_PUBLIC_KEY', keys.publicKey);
    set('VAPID_PRIVATE_KEY', keys.privateKey);
    set('VITE_VAPID_PUBLIC_KEY', keys.publicKey);
    writeFileSync(target, text);
    console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
    console.log(`تم حفظ المفتاح الخاص في ${target} (لم يُطبع).`);
  }
}
