/** Prints a fresh VAPID key pair for web push. Usage: npm run generate:vapid */
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VITE_VAPID_PUBLIC_KEY=${keys.publicKey}`);
