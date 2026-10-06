// Produces a short, rotated H.264 fixture; no user media or library is accessed.
import AVFoundation
import CoreVideo
import Foundation

let output = URL(fileURLWithPath: CommandLine.arguments[1])
let writer = try AVAssetWriter(outputURL: output, fileType: .mov)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 640, AVVideoHeightKey: 360
])
input.transform = CGAffineTransform(rotationAngle: .pi / 2)
let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
    kCVPixelBufferWidthKey as String: 640, kCVPixelBufferHeightKey as String: 360
])
writer.add(input)
guard writer.startWriting() else { fatalError("start: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)
for frame in 0..<6 {
    let deadline = Date().addingTimeInterval(10)
    while !input.isReadyForMoreMediaData && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
    guard input.isReadyForMoreMediaData else { fatalError("writer timed out") }
    var optionalBuffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adapter.pixelBufferPool!, &optionalBuffer)
    let buffer = optionalBuffer!
    CVPixelBufferLockBaseAddress(buffer, [])
    let bytes = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    for y in 0..<360 {
        for x in 0..<640 {
            let offset = y * CVPixelBufferGetBytesPerRow(buffer) + x * 4
            bytes[offset] = 255; bytes[offset + 1] = 255; bytes[offset + 2] = 0; bytes[offset + 3] = 0
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    guard adapter.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)) else {
        fatalError("frame: \(String(describing: writer.error))")
    }
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
guard done.wait(timeout: .now() + 15) == .success && writer.status == .completed else {
    fatalError("finish: \(String(describing: writer.error))")
}
print("Created 0.2s rotated H.264 fixture")
