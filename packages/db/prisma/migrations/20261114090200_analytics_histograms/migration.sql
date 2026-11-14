-- Response and resolution time histograms per local hour, so percentiles over long ranges
-- never sort millions of rows. Derived and rewritten by the rollup, like analytics_hourly.

-- CreateTable
CREATE TABLE "analytics_response_hist" (
    "org_id" UUID NOT NULL,
    "hour" TIMESTAMP(0) NOT NULL,
    "channel_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "bucket" SMALLINT NOT NULL,
    "n" INTEGER NOT NULL,

    CONSTRAINT "analytics_response_hist_pkey" PRIMARY KEY ("org_id","hour","channel_id","user_id","bucket")
);

-- CreateTable
CREATE TABLE "analytics_resolution_hist" (
    "org_id" UUID NOT NULL,
    "hour" TIMESTAMP(0) NOT NULL,
    "channel_id" UUID NOT NULL,
    "assignee_id" UUID NOT NULL,
    "bucket" SMALLINT NOT NULL,
    "n" INTEGER NOT NULL,

    CONSTRAINT "analytics_resolution_hist_pkey" PRIMARY KEY ("org_id","hour","channel_id","assignee_id","bucket")
);


ALTER TABLE analytics_response_hist   ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_response_hist   FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics_resolution_hist ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_resolution_hist FORCE ROW LEVEL SECURITY;

CREATE POLICY analytics_response_hist_org ON analytics_response_hist FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY analytics_resolution_hist_org ON analytics_resolution_hist FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
