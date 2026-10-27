import { MemoryDatabase, MemoryStore } from "../src/memory/memoryStore.js";
import { definePermissionSuite, type PermissionHarness } from "./permissions.suite.js";

definePermissionSuite("in-memory rules", (): PermissionHarness => {
  const database = new MemoryDatabase();
  return {
    async reset(docs) {
      database.clear();
      for (const [path, data] of Object.entries(docs)) database.seed(path, data);
    },
    as: (uid) => new MemoryStore(database, () => uid),
    peek: async (path) => database.peek(path),
  };
});
