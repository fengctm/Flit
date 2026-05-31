package main

import "encoding/json"

// Message types for WebSocket signaling
const (
	MsgRegister      = "register"
	MsgDeviceList    = "device_list"
	MsgDeviceOnline  = "device_online"
	MsgDeviceOffline = "device_offline"
	MsgSendRequest   = "send_request"
	MsgSendResponse  = "send_response"
	MsgWebRTCOffer   = "webrtc_offer"
	MsgWebRTCAnswer  = "webrtc_answer"
	MsgICECandidate  = "ice_candidate"
	MsgRegistered    = "registered"
	MsgError         = "error"
)

// Message is the top-level WebSocket message envelope
type Message struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// DeviceInfo holds device metadata
type DeviceInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	IP   string `json:"ip"`
	OS   string `json:"os"`
}

// RegisterData is sent by client to register
type RegisterData struct {
	Device struct {
		Name string `json:"name"`
		OS   string `json:"os"`
	} `json:"device"`
}

// DeviceListData is sent to client with all online devices
type DeviceListData struct {
	Devices []DeviceInfo `json:"devices"`
}

// DeviceOnlineData broadcasts a new device
type DeviceOnlineData struct {
	Device DeviceInfo `json:"device"`
}

// DeviceOfflineData broadcasts device departure
type DeviceOfflineData struct {
	DeviceID string `json:"deviceID"`
}

// FileInfo describes a single file to transfer
type FileInfo struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// SendRequestData is a file send request
type SendRequestData struct {
	To    string     `json:"to"`
	From  string     `json:"from"`
	Files []FileInfo `json:"files"`
}

// SendResponseData is the accept/reject response
type SendResponseData struct {
	To       string `json:"to"`
	From     string `json:"from,omitempty"`
	Accepted bool   `json:"accepted"`
}

// WebRTCSignalData carries SDP or ICE candidate
type WebRTCSignalData struct {
	To        string          `json:"to"`
	From      string          `json:"from,omitempty"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
}

// ErrorData is an error message from server
type ErrorData struct {
	Message string `json:"message"`
}
