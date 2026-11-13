/**
 * Minimal ambient surface of sodium-native as used by the crypto tests
 * (the package ships no type declarations).
 */
declare module 'sodium-native' {
  interface SodiumNative {
    crypto_secretstream_xchacha20poly1305_STATEBYTES: number;
    crypto_secretstream_xchacha20poly1305_HEADERBYTES: number;
    crypto_secretstream_xchacha20poly1305_KEYBYTES: number;
    crypto_secretstream_xchacha20poly1305_ABYTES: number;
    crypto_secretstream_xchacha20poly1305_TAG_MESSAGE: number;
    crypto_secretstream_xchacha20poly1305_TAG_PUSH: number;
    crypto_secretstream_xchacha20poly1305_TAG_REKEY: number;
    crypto_secretstream_xchacha20poly1305_TAG_FINAL: number;
    crypto_secretstream_xchacha20poly1305_init_push(
      state: Buffer, header: Buffer, k: Buffer,
    ): void;
    crypto_secretstream_xchacha20poly1305_init_pull(
      state: Buffer, header: Buffer, k: Buffer,
    ): void;
    crypto_secretstream_xchacha20poly1305_push(
      state: Buffer, c: Buffer, m: Buffer, ad: Buffer | null, tag: number,
    ): void;
    crypto_secretstream_xchacha20poly1305_pull(
      state: Buffer, m: Buffer, tag: Buffer, c: Buffer, ad: Buffer | null,
    ): number;
    crypto_scalarmult_base(out: Buffer, n: Buffer): number;
    crypto_scalarmult(out: Buffer, n: Buffer, p: Buffer): number;
  }
  const sodium: SodiumNative;
  export = sodium;
}

declare module 'aes-js' {
  namespace ModeOfOperation {
    class cfb {
      constructor(key: Buffer | Uint8Array, iv: Buffer | Uint8Array, segmentSize?: number);
      encrypt(plaintext: Buffer | Uint8Array): Uint8Array;
      decrypt(ciphertext: Buffer | Uint8Array): Uint8Array;
    }
  }
  const aesJs: { ModeOfOperation: typeof ModeOfOperation };
  export = aesJs;
}
