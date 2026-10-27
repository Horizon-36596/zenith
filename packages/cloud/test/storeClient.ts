/**
 * A `CloudBackend` over any `DocStore` with a fixed signed-in user, for running the flow suite
 * against the Firestore emulator without the Authentication emulator: the emulator takes the user
 * from a mock token on the connection instead (ADR 0009 section 5).
 */
import type { CloudUser, SignInProvider } from "../src/backend.js";
import { CloudClient } from "../src/client.js";
import { CloudError } from "../src/errors.js";
import { cryptoRandomBytes } from "../src/ids.js";
import type { DocStore } from "../src/store.js";

export class StoreClient extends CloudClient {
  readonly kind = "firebase" as const;
  private online = true;

  constructor(
    private readonly docs: DocStore,
    private readonly uidValue: string | null,
    private readonly network: (online: boolean) => Promise<void> = async () => undefined,
    private readonly emailValue: string | null = null,
  ) {
    super({ random: cryptoRandomBytes });
  }

  protected store(): DocStore {
    return this.docs;
  }

  currentUser(): CloudUser | null {
    return this.uidValue === null ? null : { uid: this.uidValue, email: this.emailValue, providerIds: ["emulator"] };
  }

  onAuthChange(listener: (user: CloudUser | null) => void): () => void {
    listener(this.currentUser());
    return () => undefined;
  }

  async signInWithProvider(_provider: SignInProvider): Promise<CloudUser> {
    throw new CloudError("invalid", "The test client has a fixed user.");
  }

  async signInWithNativeCredential(): Promise<CloudUser> {
    throw new CloudError("invalid", "The test client has a fixed user.");
  }

  async sendSignInLink(): Promise<void> {
    throw new CloudError("invalid", "The test client has a fixed user.");
  }

  isSignInLink(): boolean {
    return false;
  }

  async completeSignInLink(): Promise<CloudUser> {
    throw new CloudError("invalid", "The test client has a fixed user.");
  }

  async signOut(): Promise<void> {
    throw new CloudError("invalid", "The test client has a fixed user.");
  }

  isOnline(): boolean {
    return this.online;
  }

  async setOnline(online: boolean): Promise<void> {
    this.online = online;
    await this.network(online);
    this.outboxList.notify();
  }

  protected async confirmRecentSignIn(): Promise<void> {}

  protected async deleteSignInAccount(): Promise<void> {}
}
