package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	hub := newHub()
	go hub.run()

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r)
	})

	fs := http.FileServer(http.Dir("./static"))
	http.Handle("/", fs)

	addr := "0.0.0.0:" + port
	printLANIPs(port)

	log.Printf("Flit 局域网快传服务启动于 %s", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}

func printLANIPs(port string) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return
	}
	fmt.Println("========================================")
	fmt.Println("  Flit - 局域网快传")
	fmt.Println("========================================")
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() && ipNet.IP.To4() != nil {
			fmt.Printf("  http://%s:%s\n", ipNet.IP.String(), port)
		}
	}
	fmt.Println("========================================")
}
