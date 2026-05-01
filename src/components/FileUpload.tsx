'use client';

import { useRef, useState } from 'react';

interface FileUploadProps {
  onFile: (file: File) => void;
  fileName?: string;
}

export default function FileUpload({ onFile, fileName }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handle = (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'svg' && ext !== 'dxf') {
      alert('Please upload an SVG or DXF file.');
      return;
    }
    onFile(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handle(file);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors select-none
        ${dragging ? 'border-blue-400 bg-blue-950/30' : 'border-slate-600 hover:border-slate-400 bg-slate-800/50'}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".svg,.dxf"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handle(f); }}
      />
      <svg className="mx-auto mb-2 w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
      </svg>
      {fileName ? (
        <p className="text-sm text-blue-400 font-medium">{fileName}</p>
      ) : (
        <>
          <p className="text-sm font-medium text-slate-300">Drop design file here</p>
          <p className="text-xs text-slate-500 mt-1">SVG or DXF — click to browse</p>
        </>
      )}
    </div>
  );
}
