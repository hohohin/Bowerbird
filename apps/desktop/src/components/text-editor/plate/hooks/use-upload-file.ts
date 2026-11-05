import { useEffect, useRef, useState } from 'react';
import { notifyError } from '../../../../lib/notify';
import { useTextEditorServices, type EditorUpload } from '../../TextEditorServices';

export function useUploadFile() {
  const { upload } = useTextEditorServices();
  const [uploadedFile, setUploadedFile] = useState<EditorUpload>();
  const [uploadingFile, setUploadingFile] = useState<File>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function uploadFile(file: File) {
    setUploadingFile(file);
    try {
      const uploaded = await upload(file);
      if (mounted.current) setUploadedFile(uploaded);
    } catch (error) { console.error('[text-editor upload]', error); notifyError(error, '文件未能插入，请检查原件后重试。'); }
    finally { if (mounted.current) setUploadingFile(undefined); }
  }
  return { uploadedFile, uploadingFile, uploadFile, isUploading: !!uploadingFile, progress: 0 };
}
