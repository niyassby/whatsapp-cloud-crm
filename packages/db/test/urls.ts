import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { testDbUrls } from '../src/testing';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const urls = testDbUrls('wacrm_test');
/** Owner connection to the throwaway test database (migrations + fixtures). */
export const TEST_DIRECT_URL = urls.directUrl;
/** App-role connection to the test database (subject to RLS). */
export const TEST_DATABASE_URL = urls.appUrl;
