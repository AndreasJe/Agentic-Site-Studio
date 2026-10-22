// The app's own signing key lives in `server/release/keys.ts` (the release side owns it). This
// re-export keeps the deployment side's imports short.
export { appSigningPublicKey, signAppCommand } from '../release/keys.ts'
