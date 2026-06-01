package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
)

func main() {
	defaultPort := os.Getenv("PORT")
	if defaultPort == "" {
		defaultPort = "8080"
	}
	port := flag.String("port", defaultPort, "listen port (also settable via PORT env)")
	flag.Parse()

	hub := newHub()
	go hub.run()

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r)
	})

	Fs := http.FileServer(http.Dir("./static"))
	http.Handle("/", Fs)

	addr := "0.0.0.0:" + *port
	printLANIps(*port)

	log.Printf("Flit server started on %s", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}

func printLANIps(port string) {
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
