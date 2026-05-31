package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// Client represents a connected WebSocket client
type Client struct {
	ID         string
	Device     DeviceInfo
	Send       chan []byte
	Hub        *Hub
	Conn       *websocket.Conn
	Registered bool // true after client sends register message
}

// Hub maintains the set of active clients and broadcasts messages
type Hub struct {
	clients    map[string]*Client // id -> client
	ipClients  map[string]*Client // ip -> client (for dedup)
	register   chan *Client
	unregister chan *Client
}

func newHub() *Hub {
	return &Hub{
		clients:    make(map[string]*Client),
		ipClients:  make(map[string]*Client),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			// Dedup: if same IP already connected, close old connection
			if old, ok := h.ipClients[client.Device.IP]; ok && old.ID != client.ID {
				log.Printf("[替换] %s (%s) 被新连接替换", old.Device.Name, old.Device.IP)
				delete(h.clients, old.ID)
				close(old.Send)
				old.Conn.Close()
			}

			h.clients[client.ID] = client
			h.ipClients[client.Device.IP] = client
			// Do NOT broadcast yet — wait for register message with device name

		case client := <-h.unregister:
			if _, ok := h.clients[client.ID]; ok {
				delete(h.clients, client.ID)
				// Only remove from ipClients if this client still owns it
				if cur, exists := h.ipClients[client.Device.IP]; exists && cur.ID == client.ID {
					delete(h.ipClients, client.Device.IP)
				}
				close(client.Send)

				if client.Registered {
					offlineMsg := buildMessage(MsgDeviceOffline, DeviceOfflineData{DeviceID: client.ID})
					for _, c := range h.clients {
						if c.Registered {
							c.Send <- offlineMsg
						}
					}
					log.Printf("[离线] %s (%s)", client.Device.Name, client.Device.IP)
				}
			}
		}
	}
}

// broadcastDeviceList sends the full device list to all registered clients
func (h *Hub) broadcastDeviceList() {
	devices := make([]DeviceInfo, 0)
	for _, c := range h.clients {
		if c.Registered {
			devices = append(devices, c.Device)
		}
	}
	listMsg := buildMessage(MsgDeviceList, DeviceListData{Devices: devices})
	for _, c := range h.clients {
		if c.Registered {
			c.Send <- listMsg
		}
	}
}

// broadcastDeviceOnline notifies all registered clients about a new device
func (h *Hub) broadcastDeviceOnline(device DeviceInfo) {
	onlineMsg := buildMessage(MsgDeviceOnline, DeviceOnlineData{Device: device})
	for _, c := range h.clients {
		if c.Registered && c.Device.ID != device.ID {
			c.Send <- onlineMsg
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		c.Hub.unregister <- c
		c.Conn.Close()
	}()
	c.Conn.SetReadLimit(64 * 1024)
	c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	for {
		_, raw, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("读取错误: %v", err)
			}
			return
		}
		c.handleMessage(raw)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) handleMessage(raw []byte) {
	var base struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &base); err != nil {
		c.sendError("无效的消息格式")
		return
	}

	switch base.Type {
	case MsgRegister:
		var data RegisterData
		if err := json.Unmarshal(raw, &data); err != nil {
			c.sendError("无效的注册数据")
			return
		}
		name := data.Device.Name
		if name == "" {
			name = "未知设备"
		}
		c.Device.Name = name + " / " + c.Device.IP
		c.Device.OS = data.Device.OS
		c.Registered = true

		// Send registered response with client ID
		regResp := buildMessage(MsgRegistered, struct {
			ID string `json:"id"`
		}{ID: c.ID})
		c.Send <- regResp

		// Send full device list to this client (including others)
		devices := make([]DeviceInfo, 0)
		for _, other := range c.Hub.clients {
			if other.Registered && other.ID != c.ID {
				devices = append(devices, other.Device)
			}
		}
		listMsg := buildMessage(MsgDeviceList, DeviceListData{Devices: devices})
		c.Send <- listMsg

		// Broadcast new device to all other registered clients
		c.Hub.broadcastDeviceOnline(c.Device)
		log.Printf("[上线] %s (%s)", c.Device.Name, c.Device.IP)

	case MsgSendRequest:
		if !c.Registered {
			c.sendError("请先注册")
			return
		}
		var data SendRequestData
		if err := json.Unmarshal(raw, &data); err != nil {
			c.sendError("无效的发送请求")
			return
		}
		data.From = c.ID
		if target, ok := c.Hub.clients[data.To]; ok && target.Registered {
			msg := buildMessage(MsgSendRequest, data)
			target.Send <- msg
		} else {
			c.sendError("目标设备不在线")
		}

	case MsgSendResponse:
		if !c.Registered {
			c.sendError("请先注册")
			return
		}
		var data SendResponseData
		if err := json.Unmarshal(raw, &data); err != nil {
			c.sendError("无效的响应")
			return
		}
		if target, ok := c.Hub.clients[data.To]; ok && target.Registered {
			resp := SendResponseData{To: data.To, From: c.ID, Accepted: data.Accepted}
			msg := buildMessage(MsgSendResponse, resp)
			target.Send <- msg
		}

	case MsgWebRTCOffer, MsgWebRTCAnswer, MsgICECandidate:
		if !c.Registered {
			c.sendError("请先注册")
			return
		}
		var data WebRTCSignalData
		if err := json.Unmarshal(raw, &data); err != nil {
			c.sendError("无效的WebRTC信令")
			return
		}
		if target, ok := c.Hub.clients[data.To]; ok && target.Registered {
			envelope := struct {
				Type      string          `json:"type"`
				From      string          `json:"from"`
				SDP       string          `json:"sdp,omitempty"`
				Candidate json.RawMessage `json:"candidate,omitempty"`
			}{
				Type:      base.Type,
				From:      c.ID,
				SDP:       data.SDP,
				Candidate: data.Candidate,
			}
			out, _ := json.Marshal(envelope)
			target.Send <- out
		} else {
			c.sendError("目标设备不在线")
		}

	default:
		c.sendError("未知消息类型: " + base.Type)
	}
}

func (c *Client) sendError(msg string) {
	errMsg := buildMessage(MsgError, ErrorData{Message: msg})
	c.Send <- errMsg
}

// normalizeIP converts IPv6 loopback to IPv4 format
func normalizeIP(ip string) string {
	if ip == "::1" || ip == "[::1]" {
		return "127.0.0.1"
	}
	// Strip IPv6 brackets if present
	if strings.HasPrefix(ip, "[") && strings.HasSuffix(ip, "]") {
		ip = ip[1 : len(ip)-1]
	}
	return ip
}

func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("升级WebSocket失败: %v", err)
		return
	}

	clientID := uuid.New().String()
	ip := r.Header.Get("X-Forwarded-For")
	if ip == "" {
		ip = r.RemoteAddr
	}
	if host, _, err := net.SplitHostPort(ip); err == nil {
		ip = host
	}
	ip = normalizeIP(ip)

	client := &Client{
		ID: clientID,
		Device: DeviceInfo{
			ID:   clientID,
			Name: "",
			IP:   ip,
			OS:   "",
		},
		Send: make(chan []byte, 256),
		Hub:  hub,
		Conn: conn,
	}

	hub.register <- client

	go client.writePump()
	go client.readPump()
}

func buildMessage(msgType string, data interface{}) []byte {
	msg := struct {
		Type string      `json:"type"`
		Data interface{} `json:"data"`
	}{Type: msgType, Data: data}
	out, _ := json.Marshal(msg)
	return out
}
