import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { defineFlowSuite, type FlowHarness } from "./flows.suite.js";

defineFlowSuite("MemoryBackend", (): FlowHarness => {
  const database = new MemoryDatabase();
  return {
    async reset(docs) {
      database.clear();
      for (const [path, data] of Object.entries(docs)) database.seed(path, data);
    },
    async user(uid, options) {
      const backend = new MemoryBackend({ database });
      backend.signInAs(uid, options?.email === undefined ? {} : { email: options.email });
      return backend;
    },
    anonymous: async () => new MemoryBackend({ database }),
    peek: async (path) => database.peek(path),
  };
});
