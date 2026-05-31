/**
 * transfer.js - 文件分片传输
 * 负责：文件分片发送、二进制协议编解码、并发传输、接收组装、进度追踪、流式写入
 */
(function () {
    'use strict';

    // ===================== 常量定义 =====================

    /** 分片大小：64KB */
    const CHUNK_SIZE = 64 * 1024;

    /** 大文件阈值：200MB（超过此大小使用 File System Access API） */
    const LARGE_FILE_THRESHOLD = 200 * 1024 * 1024;

    /** 进度更新间隔（毫秒） */
    const PROGRESS_INTERVAL = 500;

    /** 控制通道索引（第一个通道用于 JSON 控制消息） */
    const CONTROL_CHANNEL = 0;

    // ===================== 传输状态类型 =====================

    /**
     * @typedef {Object} TransferState
     * @property {string} fileId - 文件唯一 ID
     * @property {string} fileName - 文件名
     * @property {number} fileSize - 文件大小（字节）
     * @property {string} targetId - 目标设备 ID（发送时）/ 来源设备 ID（接收时）
     * @property {string} direction - 'send' | 'receive'
     * @property {string} status - 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled'
     * @property {number} transferred - 已传输字节数
     * @property {number} speed - 当前速度（字节/秒）
     * @property {number} remainingTime - 剩余时间（秒）
     * @property {File|null} file - 发送端的 File 对象
     * @property {Map<number, ArrayBuffer>} chunks - 接收端已收到的分片（offset -> data）
     * @property {number} nextExpectedOffset - 接收端下一个期望的 offset
     * @property {Object|null} fileHandle - File System Access API 的文件句柄
     * @property {Object|null} writableStream - 文件写入流
     * @property {number} progressTimer - 进度更新定时器
     * @property {number} startTimestamp - 开始传输时间戳
     * @property {number} lastProgressTime - 上次进度更新时间
     * @property {number} lastProgressBytes - 上次进度更新时的已传输字节数
     * @property {number[]} pendingChunks - 等待写入的连续分片 offset 列表
     */

    /** @type {Map<string, TransferState>} fileId -> TransferState */
    const transfers = new Map();

    // ===================== 二进制协议编解码 =====================

    /**
     * 编码文件分片为二进制格式
     * 协议头：[4字节fileId长度 | fileId(UTF-8) | 8字节偏移量 | 4字节分片长度 | 数据]
     *
     * @param {string} fileId - 文件 ID
     * @param {number} offset - 文件偏移量
     * @param {ArrayBuffer} data - 分片数据
     * @returns {ArrayBuffer}
     */
    function encodeChunk(fileId, offset, data) {
        var encoder = new TextEncoder();
        var fileIdBytes = encoder.encode(fileId);

        // 计算总长度: 4 + fileIdBytes.length + 8 + 4 + data.byteLength
        var totalLength = 4 + fileIdBytes.length + 8 + 4 + data.byteLength;
        var buffer = new ArrayBuffer(totalLength);
        var view = new DataView(buffer);
        var pos = 0;

        // 4 字节：fileId 长度（大端序）
        view.setUint32(pos, fileIdBytes.length, false);
        pos += 4;

        // fileId 字符串
        new Uint8Array(buffer, pos, fileIdBytes.length).set(fileIdBytes);
        pos += fileIdBytes.length;

        // 8 字节：偏移量（大端序，使用 float64 模拟 uint64，支持最大 2^53）
        view.setFloat64(pos, offset, false);
        pos += 8;

        // 4 字节：分片数据长度
        view.setUint32(pos, data.byteLength, false);
        pos += 4;

        // 分片数据
        new Uint8Array(buffer, pos, data.byteLength).set(new Uint8Array(data));
        pos += data.byteLength;

        return buffer;
    }

    /**
     * 解码二进制分片
     * @param {ArrayBuffer} buffer
     * @returns {{fileId: string, offset: number, data: ArrayBuffer}}
     */
    function decodeChunk(buffer) {
        var view = new DataView(buffer);
        var pos = 0;

        // 4 字节：fileId 长度
        var fileIdLen = view.getUint32(pos, false);
        pos += 4;

        // fileId 字符串
        var decoder = new TextDecoder();
        var fileId = decoder.decode(new Uint8Array(buffer, pos, fileIdLen));
        pos += fileIdLen;

        // 8 字节：偏移量
        var offset = view.getFloat64(pos, false);
        pos = pos + 8;

        // 4 字节：分片数据长度
        var dataLen = view.getUint32(pos, false);
        pos += 4;

        // 分片数据
        var data = buffer.slice(pos, pos + dataLen);

        return { fileId: fileId, offset: offset, data: data };
    }

    // ===================== 发送文件 =====================

    /**
     * 发送文件到目标设备
     * @param {File} file - 要发送的文件
     * @param {string} targetDeviceId - 目标设备 ID
     * @returns {string} fileId - 文件 ID
     */
    function sendFile(file, targetDeviceId) {
        var fileId = generateFileId();

        /** @type {TransferState} */
        var state = {
            fileId: fileId,
            fileName: file.name,
            fileSize: file.size,
            targetId: targetDeviceId,
            direction: 'send',
            status: 'pending',
            transferred: 0,
            speed: 0,
            remainingTime: 0,
            file: file,
            chunks: null,
            nextExpectedOffset: 0,
            fileHandle: null,
            writableStream: null,
            progressTimer: null,
            startTimestamp: 0,
            lastProgressTime: 0,
            lastProgressBytes: 0,
            pendingChunks: []
        };

        transfers.set(fileId, state);

        // 渲染传输卡片
        Flit.ui.renderTransferCard(state);

        // 等待 DataChannel 就绪后开始发送
        waitForChannel(targetDeviceId, function (channels) {
            startSendChunks(state, channels);
        });

        return fileId;
    }

    /**
     * 等待 DataChannel 就绪
     * @param {string} deviceId
     * @param {function(RTCDataChannel[]): void} callback
     */
    function waitForChannel(deviceId, callback) {
        var maxWait = 10000; // 最多等待 10 秒
        var elapsed = 0;
        var interval = 100;

        var timer = setInterval(function () {
            elapsed += interval;
            var channels = Flit.webrtc.getOpenChannels(deviceId);

            if (channels.length >= 2 || elapsed >= maxWait) {
                clearInterval(timer);
                if (channels.length >= 2) {
                    callback(channels);
                } else {
                    var state = findTransferByTarget(deviceId);
                    if (state) {
                        updateTransferState(state.fileId, 'failed');
                        Flit.ui.toast('连接超时，传输失败', 'error');
                    }
                }
            }
        }, interval);
    }

    /**
     * 开始分片发送
     * @param {TransferState} state
     * @param {RTCDataChannel[]} channels - 可用的 DataChannel 数组
     */
    function startSendChunks(state, channels) {
        var file = state.file;
        var totalSize = file.size;
        var offset = 0;
        var channelIndex = 0;

        // 更新状态为传输中
        updateTransferState(state.fileId, 'transferring');
        state.startTimestamp = Date.now();
        state.lastProgressTime = Date.now();
        state.lastProgressBytes = 0;

        // 启动进度更新
        state.progressTimer = setInterval(function () {
            updateSendProgress(state);
        }, PROGRESS_INTERVAL);

        // 通过第一个通道发送开始控制消息
        var controlChannel = channels[CONTROL_CHANNEL];
        sendControlMessage(controlChannel, {
            cmd: 'start',
            fileId: state.fileId,
            name: state.fileName,
            size: state.fileSize
        });

        // 分片读取和发送
        function readAndSendNext() {
            if (state.status === 'cancelled') {
                cleanupSend(state);
                return;
            }

            if (offset >= totalSize) {
                // 所有分片已发送完毕，通知接收端
                console.log('[Transfer] 文件', state.fileName, '所有分片已发送');
                sendControlMessage(controlChannel, {
                    cmd: 'complete',
                    fileId: state.fileId
                });
                return;
            }

            var sliceEnd = Math.min(offset + CHUNK_SIZE, totalSize);
            var slice = file.slice(offset, sliceEnd);

            var reader = new FileReader();
            reader.onload = function (e) {
                if (state.status === 'cancelled') {
                    cleanupSend(state);
                    return;
                }

                var chunkData = e.target.result;

                // 编码分片
                var encoded = encodeChunk(state.fileId, offset, chunkData);

                // 选择通道（轮询）
                var sendChannel = channels[channelIndex % channels.length];
                channelIndex++;

                try {
                    sendChannel.send(encoded);
                    state.transferred = sliceEnd;
                    offset = sliceEnd;

                    // 读取并发送下一片
                    readAndSendNext();
                } catch (err) {
                    console.error('[Transfer] 发送分片失败:', err);
                    updateTransferState(state.fileId, 'failed');
                    Flit.ui.toast('发送分片失败: ' + err.message, 'error');
                    cleanupSend(state);
                }
            };

            reader.onerror = function () {
                console.error('[Transfer] 读取文件失败');
                updateTransferState(state.fileId, 'failed');
                cleanupSend(state);
            };

            reader.readAsArrayBuffer(slice);
        }

        // 开始发送
        readAndSendNext();
    }

    /**
     * 发送控制消息（JSON）
     * @param {RTCDataChannel} channel
     * @param {Object} msg
     */
    function sendControlMessage(channel, msg) {
        if (channel && channel.readyState === 'open') {
            channel.send(JSON.stringify(msg));
        }
    }

    /**
     * 更新发送进度
     * @param {TransferState} state
     */
    function updateSendProgress(state) {
        var now = Date.now();
        var elapsed = (now - state.lastProgressTime) / 1000;

        if (elapsed > 0) {
            var bytesSinceLast = state.transferred - state.lastProgressBytes;
            state.speed = bytesSinceLast / elapsed;
            state.lastProgressTime = now;
            state.lastProgressBytes = state.transferred;

            // 计算剩余时间
            var remaining = state.fileSize - state.transferred;
            state.remainingTime = state.speed > 0 ? remaining / state.speed : 0;
        }

        // 更新 UI
        Flit.ui.updateTransferCard(state);
    }

    /**
     * 清理发送状态
     * @param {TransferState} state
     */
    function cleanupSend(state) {
        if (state.progressTimer) {
            clearInterval(state.progressTimer);
            state.progressTimer = null;
        }
    }

    // ===================== 接收文件 =====================

    /**
     * 处理控制消息
     * @param {string} deviceId - 发送方设备 ID
     * @param {Object} msg - 控制消息
     * @param {number} channelIndex
     */
    function handleControlMessage(deviceId, msg, channelIndex) {
        switch (msg.cmd) {
            case 'start':
                handleReceiveStart(deviceId, msg);
                break;
            case 'complete':
                handleReceiveComplete(deviceId, msg);
                break;
            case 'cancel':
                handleReceiveCancel(deviceId, msg);
                break;
            default:
                console.log('[Transfer] 未知控制命令:', msg.cmd);
        }
    }

    /**
     * 处理接收文件开始
     * @param {string} deviceId
     * @param {Object} msg - {cmd, fileId, name, size}
     */
    function handleReceiveStart(deviceId, msg) {
        console.log('[Transfer] 开始接收文件:', msg.name, 'from', deviceId);

        /** @type {TransferState} */
        var state = {
            fileId: msg.fileId,
            fileName: msg.name,
            fileSize: msg.size,
            targetId: deviceId,
            direction: 'receive',
            status: 'transferring',
            transferred: 0,
            speed: 0,
            remainingTime: 0,
            file: null,
            chunks: new Map(),
            nextExpectedOffset: 0,
            fileHandle: null,
            writableStream: null,
            progressTimer: null,
            startTimestamp: Date.now(),
            lastProgressTime: Date.now(),
            lastProgressBytes: 0,
            pendingChunks: []
        };

        transfers.set(msg.fileId, state);

        // 渲染传输卡片
        Flit.ui.renderTransferCard(state);

        // 大文件尝试使用 File System Access API
        if (msg.size > LARGE_FILE_THRESHOLD && typeof window.showSaveFilePicker === 'function') {
            initFileStreamWriter(state);
        }

        // 启动进度更新
        state.progressTimer = setInterval(function () {
            updateReceiveProgress(state);
        }, PROGRESS_INTERVAL);
    }

    /**
     * 初始化 File System Access API 流式写入
     * @param {TransferState} state
     */
    function initFileStreamWriter(state) {
        window.showSaveFilePicker({
            suggestedName: state.fileName,
            types: [{
                description: '所有文件',
                accept: { '*/*': [] }
            }]
        }).then(function (fileHandle) {
            state.fileHandle = fileHandle;
            return fileHandle.createWritable();
        }).then(function (writableStream) {
            state.writableStream = writableStream;
            console.log('[Transfer] 使用 File System Access API 流式写入');
            // 尝试写入已缓存的分片
            flushPendingChunks(state);
        }).catch(function (err) {
            // 用户取消选择文件或其他错误，回退到 Blob 模式
            console.log('[Transfer] File System Access API 不可用或用户取消:', err.message);
            state.fileHandle = null;
            state.writableStream = null;
        });
    }

    /**
     * 写入等待队列中的分片
     * @param {TransferState} state
     */
    function flushPendingChunks(state) {
        if (!state.writableStream) return;

        while (state.pendingChunks.length > 0) {
            var nextOffset = state.pendingChunks[0];
            if (nextOffset !== state.nextExpectedOffset) break;

            var chunkData = state.chunks.get(nextOffset);
            if (!chunkData) break;

            try {
                state.writableStream.write(chunkData);
                state.pendingChunks.shift();
                state.chunks.delete(nextOffset);
                state.nextExpectedOffset += chunkData.byteLength;
                state.transferred += chunkData.byteLength;
            } catch (err) {
                console.error('[Transfer] 流式写入失败:', err);
                break;
            }
        }
    }

    /**
     * 处理接收到的二进制分片
     * @param {string} deviceId
     * @param {ArrayBuffer} buffer
     * @param {number} channelIndex
     */
    function handleBinaryMessage(deviceId, buffer, channelIndex) {
        var decoded;
        try {
            decoded = decodeChunk(buffer);
        } catch (e) {
            console.error('[Transfer] 解码分片失败:', e);
            return;
        }

        var state = transfers.get(decoded.fileId);
        if (!state) {
            console.warn('[Transfer] 收到未知 fileId 的分片:', decoded.fileId);
            return;
        }

        if (state.status === 'cancelled') return;

        // 缓存分片数据
        state.chunks.set(decoded.offset, decoded.data);
        state.pendingChunks.push(decoded.offset);

        // 排序 pendingChunks 以确保按序处理
        state.pendingChunks.sort(function (a, b) { return a - b; });

        // 如果有 File System Access API，尝试写入
        if (state.writableStream) {
            flushPendingChunks(state);
        } else {
            // Blob 模式：更新已接收字节数（用于进度显示）
            state.transferred += decoded.data.byteLength;
        }
    }

    /**
     * 处理接收完成
     * @param {string} deviceId
     * @param {Object} msg - {cmd, fileId}
     */
    function handleReceiveComplete(deviceId, msg) {
        var state = transfers.get(msg.fileId);
        if (!state) return;

        console.log('[Transfer] 文件接收完成:', state.fileName);

        // 关闭流写入
        if (state.writableStream) {
            state.writableStream.close().then(function () {
                console.log('[Transfer] 流写入已关闭');
            }).catch(function (err) {
                console.error('[Transfer] 关闭流写入失败:', err);
            });
        }

        // 如果使用 Blob 模式组装文件
        if (!state.writableStream) {
            assembleBlobAndDownload(state);
        }

        // 更新状态
        state.transferred = state.fileSize;
        state.speed = 0;
        state.remainingTime = 0;
        updateTransferState(state.fileId, 'completed');
    }

    /**
     * 使用 Blob 拼接文件并触发下载
     * @param {TransferState} state
     */
    function assembleBlobAndDownload(state) {
        // 检查文件大小
        if (state.fileSize > LARGE_FILE_THRESHOLD) {
            Flit.ui.toast('文件较大（>' + formatSize(LARGE_FILE_THRESHOLD) + '），建议使用支持 File System Access API 的浏览器', 'warning');
        }

        // 按 offset 排序并拼接
        var sortedOffsets = Array.from(state.chunks.keys()).sort(function (a, b) { return a - b; });
        var blobs = [];
        var expectedOffset = 0;

        sortedOffsets.forEach(function (offset) {
            if (offset === expectedOffset) {
                blobs.push(new Blob([state.chunks.get(offset)]));
                expectedOffset += state.chunks.get(offset).byteLength;
            }
        });

        if (blobs.length === 0) {
            console.error('[Transfer] 没有可用的分片数据');
            return;
        }

        var blob = new Blob(blobs);
        var url = URL.createObjectURL(blob);

        // 触发下载
        var a = document.createElement('a');
        a.href = url;
        a.download = state.fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        // 清理
        setTimeout(function () {
            URL.revokeObjectURL(url);
            document.body.removeChild(a);
        }, 1000);

        // 释放分片内存
        state.chunks.clear();
    }

    /**
     * 处理接收取消
     * @param {string} deviceId
     * @param {Object} msg
     */
    function handleReceiveCancel(deviceId, msg) {
        var state = transfers.get(msg.fileId);
        if (state) {
            updateTransferState(state.fileId, 'cancelled');
            Flit.ui.toast('文件传输已被取消', 'warning');
        }
    }

    // ===================== 传输完成确认 =====================

    /**
     * 通知接收方传输完成
     * @param {TransferState} state
     */
    function notifyTransferComplete(state) {
        var channels = Flit.webrtc.getOpenChannels(state.targetId);
        if (channels.length > 0) {
            sendControlMessage(channels[CONTROL_CHANNEL], {
                cmd: 'complete',
                fileId: state.fileId
            });
        }
    }

    // ===================== 进度更新 =====================

    /**
     * 更新接收进度
     * @param {TransferState} state
     */
    function updateReceiveProgress(state) {
        var now = Date.now();
        var elapsed = (now - state.lastProgressTime) / 1000;

        if (elapsed > 0) {
            var bytesSinceLast = state.transferred - state.lastProgressBytes;
            state.speed = bytesSinceLast / elapsed;
            state.lastProgressTime = now;
            state.lastProgressBytes = state.transferred;

            var remaining = state.fileSize - state.transferred;
            state.remainingTime = state.speed > 0 ? remaining / state.speed : 0;
        }

        Flit.ui.updateTransferCard(state);
    }

    // ===================== 状态管理 =====================

    /**
     * 更新传输状态
     * @param {string} fileId
     * @param {string} status - 'transferring' | 'completed' | 'failed' | 'cancelled'
     */
    function updateTransferState(fileId, status) {
        var state = transfers.get(fileId);
        if (!state) return;

        state.status = status;

        // 停止进度更新
        if (state.progressTimer) {
            clearInterval(state.progressTimer);
            state.progressTimer = null;
        }

        // 如果发送完成，通知接收方
        if (status === 'completed' && state.direction === 'send') {
            notifyTransferComplete(state);
        }

        // 更新 UI
        Flit.ui.updateTransferCard(state);
    }

    /**
     * 连接断开时的清理
     * @param {string} deviceId
     */
    function onConnectionLost(deviceId) {
        transfers.forEach(function (state) {
            if (state.targetId === deviceId && state.status === 'transferring') {
                updateTransferState(state.fileId, 'failed');
                Flit.ui.toast('与 ' + (Flit.getDevice(deviceId)?.name || deviceId) + ' 的连接断开，传输中断', 'error');
            }
        });
    }

    /**
     * 取消传输
     * @param {string} fileId
     */
    function cancelTransfer(fileId) {
        var state = transfers.get(fileId);
        if (!state) return;

        updateTransferState(fileId, 'cancelled');

        // 如果是发送，通知接收方
        if (state.direction === 'send') {
            var channels = Flit.webrtc.getOpenChannels(state.targetId);
            if (channels.length > 0) {
                sendControlMessage(channels[CONTROL_CHANNEL], {
                    cmd: 'cancel',
                    fileId: fileId
                });
            }
        }

        Flit.ui.toast('传输已取消', 'warning');
    }

    /**
     * 查找目标设备的传输任务
     * @param {string} targetId
     * @returns {TransferState|null}
     */
    function findTransferByTarget(targetId) {
        var result = null;
        transfers.forEach(function (state) {
            if (state.targetId === targetId && state.status === 'transferring') {
                result = state;
            }
        });
        return result;
    }

    // ===================== 工具函数 =====================

    /**
     * 生成唯一文件 ID
     * @returns {string}
     */
    function generateFileId() {
        return 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * 格式化文件大小
     * @param {number} bytes
     * @returns {string}
     */
    function formatSize(bytes) {
        if (bytes === 0) return '0 B';
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var k = 1024;
        var i = Math.floor(Math.log(bytes) / Math.log(k));
        var size = (bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0);
        return size + ' ' + units[i];
    }

    /**
     * 格式化传输速率
     * @param {number} bytesPerSec
     * @returns {string}
     */
    function formatSpeed(bytesPerSec) {
        if (bytesPerSec <= 0) return '0 B/s';
        var units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        var k = 1024;
        var i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
        var speed = (bytesPerSec / Math.pow(k, i)).toFixed(1);
        return speed + ' ' + units[i];
    }

    /**
     * 格式化剩余时间
     * @param {number} seconds
     * @returns {string}
     */
    function formatTime(seconds) {
        if (seconds <= 0 || !isFinite(seconds)) return '剩余 --';
        if (seconds < 60) return '剩余 ' + Math.ceil(seconds) + ' 秒';
        if (seconds < 3600) {
            var m = Math.floor(seconds / 60);
            var s = Math.ceil(seconds % 60);
            return '剩余 ' + m + ' 分 ' + s + ' 秒';
        }
        var h = Math.floor(seconds / 3600);
        var rm = Math.floor((seconds % 3600) / 60);
        return '剩余 ' + h + ' 小时 ' + rm + ' 分';
    }

    // ===================== 暴露到全局 =====================

    window.Flit = window.Flit || {};
    window.Flit.transfer = {
        sendFile: sendFile,
        cancelTransfer: cancelTransfer,
        handleControlMessage: handleControlMessage,
        handleBinaryMessage: handleBinaryMessage,
        onConnectionLost: onConnectionLost,
        updateTransferState: updateTransferState,
        transfers: transfers,
        // 工具函数
        formatSize: formatSize,
        formatSpeed: formatSpeed,
        formatTime: formatTime
    };

})();
