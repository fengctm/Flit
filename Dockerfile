FROM golang:alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /flit -ldflags "-s -w" .

FROM alpine:latest
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /flit /flit
COPY static/ /static/
EXPOSE 8080
CMD ["/flit"]
