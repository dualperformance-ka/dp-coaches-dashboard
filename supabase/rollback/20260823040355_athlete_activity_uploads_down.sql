-- Roll back the parsed activity index. Original workout files are deliberately
-- not deleted: the bucket is removed only when it is already empty.

drop table if exists public.athlete_activity_uploads;

delete from storage.buckets bucket
where bucket.id = 'athlete-activity-files'
  and not exists (
    select 1 from storage.objects object
    where object.bucket_id = bucket.id
  );
