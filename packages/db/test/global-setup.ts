import { prepareTestDatabase } from '../src/testing';
import { TEST_DATABASE_URL, TEST_DIRECT_URL } from './urls';

export default async function setup() {
  await prepareTestDatabase({ directUrl: TEST_DIRECT_URL, appUrl: TEST_DATABASE_URL });
}
