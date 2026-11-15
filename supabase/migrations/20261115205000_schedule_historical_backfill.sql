do $$
begin
  if not exists (
    select 1 from cron.job where jobname = 'nba-historical-backfill-every-15-min'
  ) then
    perform cron.schedule(
      'nba-historical-backfill-every-15-min',
      '*/15 * * * *',
      $cmd$
      DO $do$
      DECLARE
        v_job_id uuid;
        v_project_url text;
        v_publishable_key text;
      BEGIN
        UPDATE public.historical_backfill_jobs
           SET status = 'queued', updated_at = now(), last_error = 'Recovered stale running job for retry'
         WHERE status = 'running' AND updated_at < now() - interval '20 minutes';
        UPDATE public.historical_backfill_jobs main_job
           SET status = 'queued', updated_at = now()
         WHERE main_job.status = 'paused'
           AND coalesce(main_job.metadata->>'repair','false') <> 'true'
           AND EXISTS (
             SELECT 1 FROM public.historical_backfill_jobs repair
             WHERE repair.metadata->>'repair' = 'true' AND repair.status = 'completed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM public.historical_backfill_jobs repair
             WHERE repair.metadata->>'repair' = 'true' AND repair.status IN ('queued','running','failed')
           );
        SELECT id INTO v_job_id
          FROM public.historical_backfill_jobs
         WHERE status = 'queued'
         ORDER BY created_at
         LIMIT 1;
        IF v_job_id IS NOT NULL THEN
          SELECT decrypted_secret INTO v_project_url
            FROM vault.decrypted_secrets WHERE name = 'nba_analytics_project_url';
          SELECT decrypted_secret INTO v_publishable_key
            FROM vault.decrypted_secrets WHERE name = 'nba_analytics_publishable_key';
          PERFORM net.http_post(
            url := v_project_url || '/functions/v1/nba-historical-backfill',
            headers := jsonb_build_object('Content-Type','application/json','apikey',v_publishable_key),
            body := jsonb_build_object('job_id',v_job_id),
            timeout_milliseconds := 25000
          );
        END IF;
      END
      $do$;
      $cmd$
    );
  end if;
end $$;
