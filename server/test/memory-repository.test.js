import { createMemoryRepository } from '../src/repositories/memory/store.js';
import { runRepositoryContract } from './repository-contract.js';

runRepositoryContract('memory', async () => createMemoryRepository({ seed: false }));
