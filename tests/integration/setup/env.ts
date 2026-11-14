import { testAppEnv } from "../../support/local-supabase";

// Every integration test runs against the local Supabase with fake providers.
Object.assign(process.env, testAppEnv(3200));
