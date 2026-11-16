-- Run player availability checks and player forecast/evaluation every 15 minutes.
DO $$
DECLARE
  existing_job_id bigint;
BEGIN
  SELECT jobid INTO existing_job_id
  FROM cron.job
  WHERE jobname = 'nba-analytics-player-predictions-every-15-min'
  LIMIT 1;

  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;

  PERFORM cron.schedule(
    'nba-analytics-player-predictions-every-15-min',
    '*/15 * * * *',
    $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name='nba_analytics_project_url') || '/functions/v1/nba-player-predictions',
        headers := jsonb_build_object('Content-Type','application/json','apikey',(select decrypted_secret from vault.decrypted_secrets where name='nba_analytics_publishable_key')),
        body := jsonb_build_object('persist',true,'trigger','supabase_cron','requested_at',now()),
        timeout_milliseconds := 60000
      );
    $job$
  );
END $$;
