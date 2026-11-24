-- Permit the file speech MP3 in the existing private generation bucket.
update storage.buckets
set allowed_mime_types = array_append(allowed_mime_types, 'audio/mpeg')
where id = 'generation-temp'
  and public is false
  and allowed_mime_types is not null
  and array_position(allowed_mime_types, 'audio/mpeg') is null;
