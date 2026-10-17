package modsecurity

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
	"time"
)

// seen is what one side (sidecar or backend) received.
type seen struct {
	mu            sync.Mutex
	hits          int
	method        string
	uri           string
	header        http.Header
	body          []byte
	contentLength int64
}

func (s *seen) record(r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hits++
	s.method = r.Method
	s.uri = r.RequestURI
	s.header = r.Header.Clone()
	s.body = b
	s.contentLength = r.ContentLength
}

func (s *seen) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hits
}

// sidecar starts a fake ModSecurity that records each request and answers with
// status (and an optional extra header).
func sidecar(t *testing.T, status int, extra http.Header) (*httptest.Server, *seen) {
	t.Helper()
	s := &seen{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.record(r)
		for k, vv := range extra {
			w.Header()[k] = vv
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, "verdict "+http.StatusText(status))
	}))
	t.Cleanup(srv.Close)
	return srv, s
}

func backend() (http.Handler, *seen) {
	s := &seen{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.record(r)
		_, _ = io.WriteString(w, "backend")
	}), s
}

func plugin(t *testing.T, url string, next http.Handler, tweak func(*Config)) http.Handler {
	t.Helper()
	cfg := CreateConfig()
	cfg.ModSecurityURL = url
	cfg.SpoolDir = t.TempDir()
	if tweak != nil {
		tweak(cfg)
	}
	h, err := New(context.Background(), next, cfg, "test")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return h
}

func serve(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestBlockedRequestNeverReachesBackend(t *testing.T) {
	srv, side := sidecar(t, http.StatusForbidden, http.Header{"X-Verdict": {"blocked"}})
	next, back := backend()
	h := plugin(t, srv.URL, next, nil)

	rec := serve(h, httptest.NewRequest(http.MethodPost, "/login?id=1", strings.NewReader("user=' OR 1=1--")))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("X-Verdict"); got != "blocked" {
		t.Errorf("verdict header = %q, want the sidecar's", got)
	}
	if !strings.Contains(rec.Body.String(), "verdict Forbidden") {
		t.Errorf("body = %q, want the sidecar's verdict page", rec.Body.String())
	}
	if side.count() != 1 || string(side.body) != "user=' OR 1=1--" || side.uri != "/login?id=1" {
		t.Errorf("sidecar saw hits=%d uri=%q body=%q", side.count(), side.uri, side.body)
	}
	if back.count() != 0 {
		t.Errorf("backend was called %d times for a blocked request", back.count())
	}
}

func TestAllowedBodyReachesSidecarAndBackendIntact(t *testing.T) {
	sizes := []int{1, 100, defaultMemBodyBytes, defaultMemBodyBytes + 1, 5 << 20}
	for _, size := range sizes {
		body := bytes.Repeat([]byte("abcdefghij"), size/10+1)[:size]
		srv, side := sidecar(t, http.StatusOK, nil)
		next, back := backend()
		h := plugin(t, srv.URL, next, nil)

		rec := serve(h, httptest.NewRequest(http.MethodPost, "/upload", bytes.NewReader(body)))

		if rec.Code != http.StatusOK || rec.Body.String() != "backend" {
			t.Fatalf("size %d: status %d body %q", size, rec.Code, rec.Body.String())
		}
		if !bytes.Equal(side.body, body) || side.contentLength != int64(size) {
			t.Errorf("size %d: sidecar got %d bytes (Content-Length %d)", size, len(side.body), side.contentLength)
		}
		if !bytes.Equal(back.body, body) || back.contentLength != int64(size) {
			t.Errorf("size %d: backend got %d bytes (Content-Length %d)", size, len(back.body), back.contentLength)
		}
	}
}

func TestChunkedBodyIsForwardedWithItsLength(t *testing.T) {
	srv, _ := sidecar(t, http.StatusOK, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, nil)
	body := strings.Repeat("x", 200000)

	// A reader of unknown length gives ContentLength -1, as chunked framing does.
	req := httptest.NewRequest(http.MethodPost, "/", io.MultiReader(strings.NewReader(body)))
	if req.ContentLength != -1 {
		t.Fatalf("test setup: ContentLength = %d, want -1", req.ContentLength)
	}
	rec := serve(h, req)

	if rec.Code != http.StatusOK || string(back.body) != body || back.contentLength != int64(len(body)) {
		t.Fatalf("status %d, backend got %d bytes with Content-Length %d", rec.Code, len(back.body), back.contentLength)
	}
}

// The upstream plugin skipped the WAF for any request carrying
// `Upgrade: websocket`, whatever its method and body.
func TestUpgradeHeaderDoesNotSkipInspection(t *testing.T) {
	for _, hdr := range []http.Header{
		{"Upgrade": {"websocket"}},
		{"Upgrade": {"websocket"}, "Connection": {"Upgrade"}},
	} {
		srv, side := sidecar(t, http.StatusForbidden, nil)
		next, back := backend()
		h := plugin(t, srv.URL, next, nil)
		req := httptest.NewRequest(http.MethodPost, "/wp-login.php", strings.NewReader("log=admin' OR '1'='1"))
		for k, vv := range hdr {
			req.Header[k] = vv
		}

		rec := serve(h, req)

		if rec.Code != http.StatusForbidden || side.count() != 1 || back.count() != 0 {
			t.Errorf("headers %v: status %d, sidecar hits %d, backend hits %d", hdr, rec.Code, side.count(), back.count())
		}
	}
}

func TestWebsocketHandshakeIsInspectedAndStillUpgrades(t *testing.T) {
	srv, side := sidecar(t, http.StatusOK, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, nil)
	req := httptest.NewRequest(http.MethodGet, "/socket", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")

	rec := serve(h, req)

	if rec.Code != http.StatusOK || side.count() != 1 {
		t.Fatalf("status %d, sidecar hits %d", rec.Code, side.count())
	}
	if side.header.Get("Upgrade") != "" || side.header.Get("Sec-WebSocket-Key") == "" {
		t.Errorf("sidecar headers: Upgrade=%q Sec-WebSocket-Key=%q — want the handshake without hop-by-hop fields",
			side.header.Get("Upgrade"), side.header.Get("Sec-WebSocket-Key"))
	}
	if back.header.Get("Upgrade") != "websocket" || back.header.Get("Connection") != "Upgrade" {
		t.Errorf("backend lost the upgrade headers: %v", back.header)
	}
}

func TestOversizedBodyIsRefusedBeforeInspection(t *testing.T) {
	cases := map[string]func() *http.Request{
		"declared length": func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/", strings.NewReader(strings.Repeat("a", 2001)))
		},
		"unknown length": func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/", io.MultiReader(strings.NewReader(strings.Repeat("a", 2001))))
		},
	}
	for name, mk := range cases {
		srv, side := sidecar(t, http.StatusOK, nil)
		next, back := backend()
		h := plugin(t, srv.URL, next, func(c *Config) { c.MaxBodyBytes = 2000; c.MemBodyBytes = 100 })

		rec := serve(h, mk())

		if rec.Code != http.StatusRequestEntityTooLarge || side.count() != 0 || back.count() != 0 {
			t.Errorf("%s: status %d, sidecar hits %d, backend hits %d", name, rec.Code, side.count(), back.count())
		}
	}
}

func TestBodyAtTheCapIsAccepted(t *testing.T) {
	srv, _ := sidecar(t, http.StatusOK, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, func(c *Config) { c.MaxBodyBytes = 2000; c.MemBodyBytes = 100 })

	rec := serve(h, httptest.NewRequest(http.MethodPost, "/", io.MultiReader(strings.NewReader(strings.Repeat("a", 2000)))))

	if rec.Code != http.StatusOK || len(back.body) != 2000 {
		t.Fatalf("status %d, backend got %d bytes", rec.Code, len(back.body))
	}
}

// A body over memBodyBytes must go through SpoolDir: with an unusable SpoolDir
// it fails, while a small body never needs the directory.
func TestLargeBodiesAreSpooledToDisk(t *testing.T) {
	srv, _ := sidecar(t, http.StatusOK, nil)
	next, _ := backend()
	h := plugin(t, srv.URL, next, func(c *Config) {
		c.MemBodyBytes = 1024
		c.SpoolDir = filepath.Join(t.TempDir(), "missing")
	})

	if rec := serve(h, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(strings.Repeat("s", 1024)))); rec.Code != http.StatusOK {
		t.Errorf("small body: status %d, want 200 without touching SpoolDir", rec.Code)
	}
	if rec := serve(h, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(strings.Repeat("l", 1025)))); rec.Code != http.StatusInternalServerError {
		t.Errorf("large body with unusable SpoolDir: status %d, want 500 (our disk, not the client)", rec.Code)
	}
}

func TestSpoolFilesDoNotOutliveTheRequest(t *testing.T) {
	srv, _ := sidecar(t, http.StatusOK, nil)
	next, _ := backend()
	dir := t.TempDir()
	h := plugin(t, srv.URL, next, func(c *Config) { c.MemBodyBytes = 10; c.SpoolDir = dir })

	serve(h, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(strings.Repeat("z", 50000))))

	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("spool dir after request: %v entries, err %v", len(entries), err)
	}
}

// The reason for the fork: upstream read the whole body into the heap.
func TestLargeBodyDoesNotLandInTheHeap(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
	}))
	t.Cleanup(srv.Close)
	h := plugin(t, srv.URL, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
	}), nil)
	const size = 12 << 20
	body := make([]byte, size)

	// Warm the connection pool so the measurement is the request alone.
	serve(h, httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body[:10])))
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	rec := serve(h, httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body)))
	runtime.ReadMemStats(&after)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > size/4 {
		t.Fatalf("serving a %d MiB body allocated %d KiB; the body must not be held in memory", size>>20, alloc>>10)
	}
}

// replayBuf stands in for oxy's multibuf: what `waf-body-limit` puts behind
// req.Body, wrapped in io.NopCloser.
type replayBuf struct{ *bytes.Reader }

// otherSeeker is a seekable body of a type bufferedBody does not know.
type otherSeeker struct{ *bytes.Reader }

func init() { reusableBuffers["*modsecurity.replayBuf"] = true }

func bufferedRequest(body []byte) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/upload", nil)
	req.Body = io.NopCloser(&replayBuf{bytes.NewReader(body)})
	req.ContentLength = int64(len(body))
	return req
}

// Interpreted test types cannot be seen through io.NopCloser under Yaegi, so
// these run under `go test` only; the real-Traefik check covers the
// interpreter with oxy's own (compiled) buffer.
func skipUnderYaegi(t *testing.T) {
	if os.Getenv("YAEGI_TEST") != "" {
		t.Skip("needs a compiled stand-in for oxy's buffer")
	}
}

func TestBufferedBodyIsReusedNotCopied(t *testing.T) {
	skipUnderYaegi(t)
	srv, side := sidecar(t, http.StatusOK, nil)
	next, back := backend()
	// An unusable SpoolDir and a tiny memory share: only reuse can succeed.
	h := plugin(t, srv.URL, next, func(c *Config) {
		c.MemBodyBytes = 10
		c.SpoolDir = filepath.Join(t.TempDir(), "missing")
	})
	body := bytes.Repeat([]byte("0123456789"), 30000)

	rec := serve(h, bufferedRequest(body))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d — the buffered body was not reused", rec.Code)
	}
	if !bytes.Equal(side.body, body) || !bytes.Equal(back.body, body) {
		t.Fatalf("sidecar got %d bytes, backend %d, want %d each", len(side.body), len(back.body), len(body))
	}
}

func TestUnknownSeekableBodyIsNotReused(t *testing.T) {
	skipUnderYaegi(t)
	srv, _ := sidecar(t, http.StatusOK, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, func(c *Config) {
		c.MemBodyBytes = 10
		c.SpoolDir = filepath.Join(t.TempDir(), "missing")
	})
	body := bytes.Repeat([]byte("x"), 1000)
	req := httptest.NewRequest(http.MethodPost, "/upload", nil)
	req.Body = io.NopCloser(&otherSeeker{bytes.NewReader(body)})
	req.ContentLength = int64(len(body))

	rec := serve(h, req)

	if rec.Code != http.StatusInternalServerError || back.count() != 0 {
		t.Fatalf("status %d, backend hits %d — only known buffer types may be rewound; this one must be spooled (unusable here)", rec.Code, back.count())
	}
}

func TestBufferedBodyOfUnknownLengthIsNotReused(t *testing.T) {
	skipUnderYaegi(t)
	srv, _ := sidecar(t, http.StatusOK, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, func(c *Config) {
		c.MemBodyBytes = 10
		c.SpoolDir = filepath.Join(t.TempDir(), "missing")
	})
	req := bufferedRequest(bytes.Repeat([]byte("x"), 1000))
	req.ContentLength = -1

	rec := serve(h, req)

	if rec.Code != http.StatusInternalServerError || back.count() != 0 {
		t.Fatalf("status %d, backend hits %d — a buffer of unknown length must be spooled (unusable here)", rec.Code, back.count())
	}
}

func TestBufferedBodyShorterThanItsLengthFailsClosed(t *testing.T) {
	skipUnderYaegi(t)
	srv, _ := sidecar(t, http.StatusOK, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, nil)
	req := bufferedRequest([]byte("short"))
	req.ContentLength = 50

	rec := serve(h, req)

	if rec.Code != http.StatusBadGateway || back.count() != 0 {
		t.Fatalf("status %d, backend hits %d", rec.Code, back.count())
	}
}

// The sidecar may answer before it has read the body. The replay to the
// backend must still be complete and must not race the transport.
func TestBufferedBodySurvivesAnEarlyVerdict(t *testing.T) {
	skipUnderYaegi(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.CopyN(io.Discard, r.Body, 1000)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	next, back := backend()
	h := plugin(t, srv.URL, next, nil)
	body := bytes.Repeat([]byte("abcdefgh"), 1<<18)

	rec := serve(h, bufferedRequest(body))

	if rec.Code != http.StatusOK || !bytes.Equal(back.body, body) {
		t.Fatalf("status %d, backend got %d of %d bytes", rec.Code, len(back.body), len(body))
	}
}

func TestBufferedBodyDoesNotLandInTheHeap(t *testing.T) {
	skipUnderYaegi(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
	}))
	t.Cleanup(srv.Close)
	h := plugin(t, srv.URL, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
	}), nil)
	const size = 12 << 20
	body := make([]byte, size)

	serve(h, bufferedRequest(body[:10]))
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	rec := serve(h, bufferedRequest(body))
	runtime.ReadMemStats(&after)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > size/8 {
		t.Fatalf("serving a %d MiB buffered body allocated %d KiB", size>>20, alloc>>10)
	}
}

func TestSidecarUnreachableFailsClosed(t *testing.T) {
	srv, _ := sidecar(t, http.StatusOK, nil)
	url := srv.URL
	srv.Close()
	next, back := backend()
	h := plugin(t, url, next, nil)

	rec := serve(h, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusBadGateway || back.count() != 0 {
		t.Fatalf("status %d, backend hits %d — a missing WAF must block", rec.Code, back.count())
	}
}

func TestSidecarErrorStatusFailsClosed(t *testing.T) {
	srv, _ := sidecar(t, http.StatusBadGateway, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, nil)

	rec := serve(h, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusBadGateway || back.count() != 0 || strings.Contains(rec.Body.String(), "verdict") {
		t.Fatalf("status %d, backend hits %d, body %q", rec.Code, back.count(), rec.Body.String())
	}
}

func TestSlowVerdictTimesOut(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	next, back := backend()
	h := plugin(t, srv.URL, next, func(c *Config) { c.TimeoutMillis = 100 })

	start := time.Now()
	rec := serve(h, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusBadGateway || back.count() != 0 {
		t.Fatalf("status %d, backend hits %d", rec.Code, back.count())
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("took %s with a 100ms verdict timeout", took)
	}
}

// The platform's sidecar proxies to a stub whose answer to a large upload can
// stall mid-body. An allowed verdict must not wait for that body.
func TestAllowedVerdictBodyIsNotWaitedFor(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "echo of the request…")
		w.(http.Flusher).Flush()
		<-release
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	next, back := backend()
	h := plugin(t, srv.URL, next, nil)

	start := time.Now()
	rec := serve(h, httptest.NewRequest(http.MethodPost, "/upload", strings.NewReader(strings.Repeat("u", 100000))))

	if rec.Code != http.StatusOK || back.count() != 1 {
		t.Fatalf("status %d, backend hits %d", rec.Code, back.count())
	}
	if took := time.Since(start); took > time.Second {
		t.Fatalf("took %s: the plugin waited on the verdict's body", took)
	}
}

func TestBackOffIsOptInAndPassesUninspected(t *testing.T) {
	srv, side := sidecar(t, http.StatusServiceUnavailable, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, func(c *Config) {
		c.UnhealthyWafBackOffPeriodSecs = 60
		c.ModSecurityStatusRequestHeader = "X-Waf-Status"
	})

	first := serve(h, httptest.NewRequest(http.MethodGet, "/a", nil))
	second := serve(h, httptest.NewRequest(http.MethodGet, "/b", nil))

	if first.Code != http.StatusOK || second.Code != http.StatusOK || back.count() != 2 {
		t.Fatalf("statuses %d/%d, backend hits %d", first.Code, second.Code, back.count())
	}
	if side.count() != 1 {
		t.Errorf("sidecar hits = %d, want 1: the back-off window skips it", side.count())
	}
	if got := back.header.Get("X-Waf-Status"); got != "unhealthy" {
		t.Errorf("status header on the second request = %q, want unhealthy", got)
	}
}

func TestClientAddressReachesTheSidecar(t *testing.T) {
	srv, side := sidecar(t, http.StatusOK, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, nil)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.7:5555"
	req.Header.Set("X-Forwarded-For", "198.51.100.1")
	req.Header.Set("X-Real-Ip", "198.51.100.1")
	req.Header.Set("X-Forwarded-Host", "site.example.test")

	serve(h, req)

	if got := side.header.Get("X-Forwarded-For"); got != "198.51.100.1, 203.0.113.7" {
		t.Errorf("sidecar X-Forwarded-For = %q", got)
	}
	if side.header.Get("X-Real-Ip") != "198.51.100.1" || side.header.Get("X-Forwarded-Host") != "site.example.test" {
		t.Errorf("sidecar lost X-Real-Ip/X-Forwarded-Host, which the exclusion rules match on: %v", side.header)
	}
	if got := back.header.Get("X-Forwarded-For"); got != "198.51.100.1" {
		t.Errorf("backend X-Forwarded-For = %q; Traefik appends the client itself when it proxies", got)
	}
}

func TestNonOriginFormTargetsStayOnTheSidecar(t *testing.T) {
	srv, side := sidecar(t, http.StatusOK, nil)
	next, _ := backend()
	h := plugin(t, srv.URL, next, nil)

	for target, want := range map[string]string{
		"http://other.example.test/x?y=1": "/x?y=1",
		"*":                               "/*",
	} {
		req := httptest.NewRequest(http.MethodOptions, "/", nil)
		req.RequestURI = target
		if target == "*" {
			req.URL.Path = "*"
		} else {
			req.URL.Path, req.URL.RawQuery = "/x", "y=1"
		}
		rec := serve(h, req)
		if rec.Code != http.StatusOK || side.uri != want {
			t.Errorf("target %q: status %d, sidecar saw %q, want %q", target, rec.Code, side.uri, want)
		}
	}
}

// Go's server keeps a raw '#' inside the path or query and Traefik forwards it;
// the sidecar must judge the same bytes.
func TestHashInTheTargetReachesTheSidecar(t *testing.T) {
	srv, side := sidecar(t, http.StatusOK, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, nil)

	for target, want := range map[string]string{
		"/?id=1#'OR'1'='1": "/?id=1%23'OR'1'='1",
		"/a#/b?c=d":        "/a%23/b?c=d",
	} {
		rec := serve(h, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusOK || side.uri != want {
			t.Errorf("target %q: status %d, sidecar saw %q, want %q", target, rec.Code, side.uri, want)
		}
		if back.uri != target {
			t.Errorf("target %q: backend got %q — the request itself must be unchanged", target, back.uri)
		}
	}
}

func TestRedirectVerdictIsReturnedNotFollowed(t *testing.T) {
	elsewhere := &seen{}
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { elsewhere.record(r) }))
	t.Cleanup(other.Close)
	srv, _ := sidecar(t, http.StatusTemporaryRedirect, http.Header{"Location": {other.URL + "/blocked"}})
	next, back := backend()
	h := plugin(t, srv.URL, next, nil)

	rec := serve(h, httptest.NewRequest(http.MethodPost, "/form", strings.NewReader("a=1")))

	if rec.Code != http.StatusTemporaryRedirect || elsewhere.count() != 0 || back.count() != 0 {
		t.Fatalf("status %d, redirect target hits %d, backend hits %d", rec.Code, elsewhere.count(), back.count())
	}
}

func TestStatusHeaderCannotBeForged(t *testing.T) {
	srv, _ := sidecar(t, http.StatusOK, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, func(c *Config) { c.ModSecurityStatusRequestHeader = "X-Waf-Status" })
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Waf-Status", "forged-by-client")

	serve(h, req)

	if got := back.header.Get("X-Waf-Status"); got != "200" {
		t.Fatalf("status header on an allowed request = %q, want the verdict (200)", got)
	}
}

func TestVerdictHeadersReplaceEarlierOnes(t *testing.T) {
	srv, _ := sidecar(t, http.StatusForbidden, http.Header{"X-Frame-Options": {"DENY"}})
	h := plugin(t, srv.URL, http.NotFoundHandler(), nil)
	rec := httptest.NewRecorder()
	rec.Header().Set("X-Frame-Options", "SAMEORIGIN")

	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if got := rec.Header().Values("X-Frame-Options"); len(got) != 1 || got[0] != "DENY" {
		t.Fatalf("X-Frame-Options = %v, want just the verdict's", got)
	}
}

func TestUnreadableBodyIsABadRequest(t *testing.T) {
	srv, side := sidecar(t, http.StatusOK, nil)
	next, back := backend()
	h := plugin(t, srv.URL, next, nil)

	// iotest.ErrReader, not a reader type declared here: Yaegi cannot hand an
	// interpreted io.Reader through net/http and back.
	rec := serve(h, httptest.NewRequest(http.MethodPost, "/", iotest.ErrReader(errors.New("client went away"))))

	if rec.Code != http.StatusBadRequest || side.count() != 0 || back.count() != 0 {
		t.Fatalf("status %d, sidecar hits %d, backend hits %d", rec.Code, side.count(), back.count())
	}
}

func TestNewRejectsBadConfig(t *testing.T) {
	cases := map[string]func(*Config){
		"empty url":          func(c *Config) { c.ModSecurityURL = "" },
		"no scheme":          func(c *Config) { c.ModSecurityURL = "modsec-crs:80" },
		"ftp":                func(c *Config) { c.ModSecurityURL = "ftp://modsec" },
		"zero timeout":       func(c *Config) { c.TimeoutMillis = 0 },
		"zero body timeout":  func(c *Config) { c.BodyTimeoutMillis = 0 },
		"zero max body":      func(c *Config) { c.MaxBodyBytes = 0 },
		"mem over max":       func(c *Config) { c.MemBodyBytes = c.MaxBodyBytes + 1 },
		"negative mem":       func(c *Config) { c.MemBodyBytes = -1 },
		"negative back-off":  func(c *Config) { c.UnhealthyWafBackOffPeriodSecs = -1 },
		"negative max conns": func(c *Config) { c.MaxConnsPerHost = -1 },
	}
	for name, tweak := range cases {
		cfg := CreateConfig()
		cfg.ModSecurityURL = "http://modsec-crs.traefik.svc.cluster.local"
		tweak(cfg)
		if _, err := New(context.Background(), http.NotFoundHandler(), cfg, "test"); err == nil {
			t.Errorf("%s: New accepted it", name)
		}
	}
}

func TestTrailingSlashOnTheSidecarURL(t *testing.T) {
	srv, side := sidecar(t, http.StatusOK, nil)
	next, _ := backend()
	h := plugin(t, srv.URL+"/", next, nil)

	serve(h, httptest.NewRequest(http.MethodGet, "/path", nil))

	if side.uri != "/path" {
		t.Fatalf("sidecar saw %q, want /path", side.uri)
	}
}
