-- Safe, additive incident write policies for Supabase/PostgreSQL.
-- This script does NOT drop or replace policies and does NOT modify/delete rows.
-- It creates each policy only when a policy with that exact name is absent.
-- If either named policy already exists, its current definition is preserved.
--
-- Before running, you may inspect current policies with:
-- SELECT policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'incidents';

DO $safe_policy_setup$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'incidents'
      AND policyname = 'Users can create their own incidents'
  ) THEN
    EXECUTE $create_insert_policy$
      CREATE POLICY "Users can create their own incidents"
      ON public.incidents
      FOR INSERT
      WITH CHECK (auth.uid() = user_id)
    $create_insert_policy$;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'incidents'
      AND policyname = 'Users can update their own incidents'
  ) THEN
    EXECUTE $create_update_policy$
      CREATE POLICY "Users can update their own incidents"
      ON public.incidents
      FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id)
    $create_update_policy$;
  END IF;
END
$safe_policy_setup$;
