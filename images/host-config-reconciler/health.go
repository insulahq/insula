package main

import (
	"context"
	"net/http"
	"sync/atomic"
	"time"
)

// healthState publishes the last successful loop time so kubelet can declare
// the pod unhealthy after sustained stalls. Atomic int64 so the HTTP handler
// and the loop never contend on a mutex.
type healthState struct {
	lastHealthyUnix atomic.Int64
}

func (h *healthState) markHealthy(t time.Time) { h.lastHealthyUnix.Store(t.Unix()) }

// startHealthServer brings up /healthz and /readyz on addr (e.g. ":8083").
// healthz returns 503 until the first loop completes, then 503 again if the last
// success was more than 5×defaultInterval ago; readyz returns 200 once warmed up.
// The address is parameterised so the hostNetwork CONVERGE pod can use a distinct
// host port (:8084) from the observe detector's :8083.
func startHealthServer(ctx context.Context, hs *healthState, addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		last := hs.lastHealthyUnix.Load()
		if last == 0 {
			http.Error(w, "warming up", http.StatusServiceUnavailable)
			return
		}
		age := time.Now().Unix() - last
		if age > int64(5*defaultInterval.Seconds()) {
			http.Error(w, "stale", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if hs.lastHealthyUnix.Load() == 0 {
			http.Error(w, "warming up", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = srv.ListenAndServe() }()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
}
