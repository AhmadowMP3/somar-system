-- 0004_storage.sql — private buckets and read policies. Writes go through the privileged API only.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-photos', 'student-photos', false, 10485760, array['image/jpeg']),
       ('university-logos', 'university-logos', false, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
on conflict (id) do update set public = false;

-- Photos live at {university_id}/{student_id}.jpg
drop policy if exists student_photos_read on storage.objects;
create policy student_photos_read on storage.objects for select to authenticated
  using (
    bucket_id = 'student-photos'
    and (
      public.is_admin()
      or (public.current_user_role() = 'university_supervisor'
          and (storage.foldername(name))[1] = public.current_university_id()::text)
      or exists (select 1 from public.students s
                 where s.profile_id = auth.uid() and s.photo_path = storage.objects.name)
    )
  );

-- Logos live at {university_id}/logo.png and are readable by every user of that university
drop policy if exists university_logos_read on storage.objects;
create policy university_logos_read on storage.objects for select to authenticated
  using (
    bucket_id = 'university-logos'
    and (public.is_admin() or (storage.foldername(name))[1] = public.current_university_id()::text)
  );
