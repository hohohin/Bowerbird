// Runs only in disposable media workers; never on the UI thread.
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <propvarutil.h>
#include <wrl/client.h>
#include <fstream>
#include <vector>

using Microsoft::WRL::ComPtr;
#define CHECK_HR(call) do { const HRESULT hr = (call); if (FAILED(hr)) return hr; } while (0)

static HRESULT open_local_reader(const wchar_t* source, IMFAttributes* attributes, IMFSourceReader** reader) {
    // Library paths are canonical Windows paths (including \\?\ and \\?\UNC\).
    // The URL resolver rejects these; open the file without rewriting its path.
    ComPtr<IMFByteStream> stream;
    CHECK_HR(MFCreateFile(MF_ACCESSMODE_READ, MF_OPENMODE_FAIL_IF_NOT_EXIST, MF_FILEFLAGS_NONE, source, &stream));
    return MFCreateSourceReaderFromByteStream(stream.Get(), attributes, reader);
}

static HRESULT extract_frame(const wchar_t* source, const wchar_t* destination, UINT32* rotation) {
    ComPtr<IMFAttributes> attributes;
    CHECK_HR(MFCreateAttributes(&attributes, 1));
    CHECK_HR(attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE));
    ComPtr<IMFSourceReader> reader;
    CHECK_HR(open_local_reader(source, attributes.Get(), &reader));
    CHECK_HR(reader->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE));
    CHECK_HR(reader->SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE));
    ComPtr<IMFMediaType> native;
    CHECK_HR(reader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, &native));
    *rotation = MFGetAttributeUINT32(native.Get(), MF_MT_VIDEO_ROTATION, 0);
    UINT32 display_width = 0, display_height = 0;
    CHECK_HR(MFGetAttributeSize(native.Get(), MF_MT_FRAME_SIZE, &display_width, &display_height));
    ComPtr<IMFMediaType> type;
    CHECK_HR(MFCreateMediaType(&type));
    CHECK_HR(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
    CHECK_HR(type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32));
    CHECK_HR(reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, type.Get()));
    ComPtr<IMFSample> sample;
    // A decoder may consume several packets before producing the first display frame.
    for (unsigned attempt = 0; attempt < 256 && !sample; ++attempt) {
        DWORD flags = 0;
        CHECK_HR(reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, nullptr, &flags, nullptr, &sample));
        if (flags & MF_SOURCE_READERF_ERROR) return E_FAIL;
        if (!sample && (flags & MF_SOURCE_READERF_ENDOFSTREAM)) return E_FAIL;
    }
    if (!sample) return E_FAIL;
    type.Reset();
    CHECK_HR(reader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, &type));
    UINT32 width = 0, height = 0;
    CHECK_HR(MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &width, &height));
    if (!width || !height || width > 16384 || height > 16384 || UINT64(width) * height > 64000000) return E_INVALIDARG;
    // Some decoders pad the RGB frame to macroblock boundaries (e.g. 540 -> 544).
    // Keep the visible aperture, not that storage padding, in the saved cover.
    UINT32 left = 0, top = 0;
    MFVideoArea area = {};
    if (SUCCEEDED(type->GetBlob(MF_MT_MINIMUM_DISPLAY_APERTURE, reinterpret_cast<BYTE*>(&area), sizeof(area), nullptr)) ||
        SUCCEEDED(type->GetBlob(MF_MT_GEOMETRIC_APERTURE, reinterpret_cast<BYTE*>(&area), sizeof(area), nullptr))) {
        if (area.OffsetX.value < 0 || area.OffsetY.value < 0 || area.Area.cx <= 0 || area.Area.cy <= 0) return E_INVALIDARG;
        left = area.OffsetX.value; top = area.OffsetY.value;
        display_width = area.Area.cx; display_height = area.Area.cy;
    }
    if (!display_width || !display_height || UINT64(left) + display_width > width || UINT64(top) + display_height > height) return E_INVALIDARG;
    ComPtr<IMFMediaBuffer> buffer;
    CHECK_HR(sample->ConvertToContiguousBuffer(&buffer));
    // Lock exposes the contiguous representation; honor signed RGB row stride.
    LONG stride = 0;
    UINT32 stored_stride = 0;
    if (SUCCEEDED(type->GetUINT32(MF_MT_DEFAULT_STRIDE, &stored_stride))) stride = static_cast<LONG>(stored_stride);
    else CHECK_HR(MFGetStrideForBitmapInfoHeader(MFVideoFormat_RGB32.Data1, width, &stride));
    const UINT64 row_bytes = stride < 0 ? -INT64(stride) : stride;
    if (row_bytes < UINT64(width) * 4) return E_INVALIDARG;
    // Allocate before locking so allocation failure cannot leave the buffer locked.
    std::vector<BYTE> pixels(size_t(display_width) * display_height * 4);
    BYTE* data = nullptr;
    DWORD length = 0;
    CHECK_HR(buffer->Lock(&data, nullptr, &length));
    if (row_bytes * (height - 1) + UINT64(width) * 4 > length) { buffer->Unlock(); return E_INVALIDARG; }
    const BYTE* first = stride < 0 ? data + row_bytes * (height - 1) : data;
    for (UINT32 y = 0; y < display_height; ++y) {
        memcpy(pixels.data() + size_t(y) * display_width * 4, first + INT64(y + top) * stride + size_t(left) * 4, size_t(display_width) * 4);
    }
    buffer->Unlock();
    BITMAPFILEHEADER file = {};
    file.bfType = 0x4d42;
    file.bfOffBits = sizeof(file) + sizeof(BITMAPINFOHEADER);
    file.bfSize = file.bfOffBits + static_cast<DWORD>(pixels.size());
    BITMAPINFOHEADER info = {};
    info.biSize = sizeof(info); info.biWidth = display_width; info.biHeight = -static_cast<LONG>(display_height);
    info.biPlanes = 1; info.biBitCount = 32; info.biCompression = BI_RGB;
    std::ofstream output(destination, std::ios::binary | std::ios::trunc);
    output.write(reinterpret_cast<const char*>(&file), sizeof(file));
    output.write(reinterpret_cast<const char*>(&info), sizeof(info));
    output.write(reinterpret_cast<const char*>(pixels.data()), pixels.size());
    output.close();
    return output ? S_OK : E_FAIL;
}

extern "C" int bowerbird_windows_video_frame(const wchar_t* source, const wchar_t* destination, UINT32* rotation) {
    const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(com)) return com;
    const HRESULT media = MFStartup(MF_VERSION, MFSTARTUP_FULL);
    HRESULT result = media;
    if (SUCCEEDED(media)) {
        try { result = extract_frame(source, destination, rotation); }
        catch (...) { result = E_FAIL; }
        MFShutdown();
    }
    CoUninitialize();
    return result;
}

// Metadata only: do not request decoded frames or instantiate a video renderer.
static HRESULT probe_video(const wchar_t* source, UINT32* width, UINT32* height, double* duration) {
    ComPtr<IMFSourceReader> reader;
    CHECK_HR(open_local_reader(source, nullptr, &reader));
    ComPtr<IMFMediaType> type;
    CHECK_HR(reader->GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &type));
    CHECK_HR(MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, width, height));
    const UINT32 rotation = MFGetAttributeUINT32(type.Get(), MF_MT_VIDEO_ROTATION, 0);
    if (rotation == 90 || rotation == 270) {
        const UINT32 previous_width = *width; *width = *height; *height = previous_width;
    }
    PROPVARIANT value;
    PropVariantInit(&value);
    const HRESULT result = reader->GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE, MF_PD_DURATION, &value);
    if (SUCCEEDED(result) && value.vt == VT_UI8) *duration = value.uhVal.QuadPart / 10000000.0;
    PropVariantClear(&value);
    return result;
}

extern "C" int bowerbird_windows_video_probe(const wchar_t* source, UINT32* width, UINT32* height, double* duration) {
    const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(com)) return com;
    const HRESULT media = MFStartup(MF_VERSION, MFSTARTUP_FULL);
    HRESULT result = media;
    if (SUCCEEDED(media)) {
        try { result = probe_video(source, width, height, duration); }
        catch (...) { result = E_FAIL; }
        MFShutdown();
    }
    CoUninitialize();
    return result;
}
