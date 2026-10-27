/* Weather Station — nastavení motivu před vykreslením stránky. */
    // Režim nastavíme před prvním vykreslením, včetně otevření přímo ze souboru.
    try { const savedTheme = localStorage.getItem('weather-station-theme'); document.documentElement.dataset.theme = ['light','dark'].includes(savedTheme) ? savedTheme : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch (_) { document.documentElement.dataset.theme = 'dark'; }
  

/* Weather Station — navigace, komponenty a datová rozhraní. */
    /* ==========================================================================
       POMOCNÁ FUNKCE PRO SYNCHRONIZACI STAVU DO URL (BEZ RELOADU)
       ========================================================================== */
    function updateUrlParam(key, value) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set(key, value);
        window.history.replaceState({}, '', url);
      } catch (_) {
        // Ignorovat v lokálním sandboxu bez platné URL
      }
    }

    /* ==========================================================================
       HORNÍ SEGMENTOVANÝ CAROUSEL
       ========================================================================== */
    class LiquidSegCarousel {
      constructor() {
        this.control       = document.getElementById('segControl');
        this.reel          = document.getElementById('segReel');
        this.track         = document.getElementById('segLensTrack');
        this.lensBody      = document.getElementById('segLensBody');
        this.items         = Array.from(this.control.querySelectorAll('.seg-item'));
        this.fadeLeft      = document.getElementById('fadeLeft');
        this.fadeRight     = document.getElementById('fadeRight');
        this.timeIndicator = document.getElementById('activeTimeIndicator');

        this.totalItems     = this.items.length;
        this.visibleCount   = 5;
        this.maxScrollSlots = 4;

        this.itemWidth   = 68;
        this.activeIndex = 1; // Default "24 hod"

        try {
          const urlTime = new URLSearchParams(window.location.search).get('time');
          if (urlTime) {
            const foundIdx = this.items.findIndex(item => item.dataset.code === urlTime);
            if (foundIdx !== -1) this.activeIndex = foundIdx;
          }
        } catch (_) {}

        this.isDragging      = false;
        this.pointerDown     = false;
        this.activePointerId = null;
        this.isInteracting   = false;
        this.cachedRect      = null;

        this.lastMeasuredWidth    = 0;
        this.lastMeasuredVisCount = 0;
        this.lastUnderLensSlot    = -1;
        this.lastDisplayedSlot    = -1;
        this.lastFadeLeft         = '';
        this.lastFadeRight        = '';
        this.lastItemScales       = new Array(this.totalItems).fill('1');

        this.currLensX  = 0;
        this.currLensY  = 0;
        this.currReelX  = 0;
        this.lensScaleX = 1;
        this.lensScaleY = 1;

        this.barX      = 0;
        this.barY      = 0;
        this.barScaleX = 1;
        this.barScaleY = 1;

        this.pressBarScaleX  = 1.025;
        this.pressBarScaleY  = 1.04;
        this.pressBarLiftY   = -0.9;
        this.pressLensScaleX = 1.22;
        this.pressLensScaleY = 1.38;

        this.maxBarShiftX    = 4.0;
        this.maxBarShiftY    = 1.4;
        this.maxLensShiftY   = 1.8;
        this.maxLensOverrunX = 3.5;

        this.maxBarNarrowX   = 0.032;
        this.maxBarStretchY  = 0.040;

        this.targetLensX      = 0;
        this.targetLensY      = 0;
        this.targetReelX      = 0;
        this.targetBarX       = 0;
        this.targetBarY       = 0;
        this.targetBarScaleX  = 1;
        this.targetBarScaleY  = 1;
        this.targetLensScaleX = 1;
        this.targetLensScaleY = 1;

        this.autoScrollSpeed = 0;
        this.lastFrameTime   = 0;
        this.lastPointerX    = 0;

        this.startX = 0;
        this.startY = 0;

        this.animFromLensX      = 0;
        this.animToLensX        = 0;
        this.animFromReelX      = 0;
        this.animToReelX        = 0;
        this.animFromY          = 0;
        this.animFromBarX       = 0;
        this.animFromBarY       = 0;
        this.animFromBarScaleX  = 1;
        this.animFromBarScaleY  = 1;
        this.animFromLensScaleX = 1;
        this.animFromLensScaleY = 1;
        this.edgeNudgeDir       = 0;

        this.animStartTime = 0;
        this.animDuration  = 280;

        this.rafId         = null;
        this.holdRafId     = null;
        this.collapseTimer = null;

        this.init();
      }

      init() {
        this.measure();
        const { reelX, lensX } = this.calculateSnapTargets(this.activeIndex);
        this.currReelX   = reelX;
        this.targetReelX = reelX;
        this.currLensX   = lensX;
        this.targetLensX = lensX;
        this.render();
        this.updateUnderLensHighlight();

        if (this.timeIndicator && this.items[this.activeIndex]) {
          this.timeIndicator.textContent = `Vybráno: ${this.items[this.activeIndex].dataset.time}`;
        }

        this.resizeObserver = new ResizeObserver(() => {
          if (this.pointerDown) return;
          const prevItemWidth = this.itemWidth || 68;
          const currentScrollSlots = Math.round(-this.currReelX / prevItemWidth);
          this.resetTransformState();
          this.measure();
          const { reelX, lensX } = this.calculateSnapTargets(this.activeIndex, currentScrollSlots);
          this.currReelX   = reelX;
          this.targetReelX = reelX;
          this.currLensX   = lensX;
          this.targetLensX = lensX;
          this.render();
          this.updateUnderLensHighlight();
        });
        this.resizeObserver.observe(this.control);

        this.items.forEach((item, index) => {
          item.addEventListener('click', () => {
            if (this.isDragging) return;
            this.glideToIndex(index);
          });
        });

        this.control.addEventListener('contextmenu', (e) => e.preventDefault());

        this.control.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        window.addEventListener('pointermove',   (e) => this.onPointerMove(e), { passive: true });
        window.addEventListener('pointerup',     (e) => this.onPointerUp(e),   { passive: true });
        window.addEventListener('pointercancel', (e) => this.onPointerUp(e),   { passive: true });

        window.addEventListener('blur', () => this.forceCancelInteraction(), { passive: true });
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) this.forceCancelInteraction();
        });
      }

      damp(current, target, speed, dt) {
        return current + (target - current) * (1 - Math.exp(-speed * dt));
      }

      resetTransformState() {
        this.currLensY       = 0;
        this.barX            = 0;
        this.barY            = 0;
        this.barScaleX       = 1;
        this.barScaleY       = 1;
        this.lensScaleX      = 1;
        this.lensScaleY      = 1;
        this.autoScrollSpeed = 0;
      }

      forceCancelInteraction() {
        if (this.pointerDown) {
          this.onPointerUp({ pointerId: this.activePointerId });
        }
      }

      measure() {
        const isDesktop     = window.matchMedia('(min-width: 640px)').matches;
        this.visibleCount   = isDesktop ? this.totalItems : 5;
        this.maxScrollSlots = this.totalItems - this.visibleCount;

        const width  = this.control.offsetWidth;
        const height = this.control.offsetHeight;
        const rect   = this.control.getBoundingClientRect();

        const originX = rect.left + rect.width * 0.5 - this.barX;
        const originY = rect.top  + rect.height * 0.15 - this.barY;

        this.cachedRect = {
          left:   originX - width * 0.5,
          top:    originY - height * 0.15,
          width:  width,
          height: height
        };

        this.itemWidth = (width - 8) / this.visibleCount;

        if (width !== this.lastMeasuredWidth || this.visibleCount !== this.lastMeasuredVisCount) {
          this.lastMeasuredWidth    = width;
          this.lastMeasuredVisCount = this.visibleCount;

          this.reel.style.width = (this.totalItems * this.itemWidth) + 'px';
          this.items.forEach(item => {
            item.style.width     = this.itemWidth + 'px';
            item.style.flexBasis = this.itemWidth + 'px';
          });
          this.track.style.width = this.itemWidth + 'px';
        }
      }

      easeOutGlide(t) {
        return 1 - Math.pow(1 - t, 3.2);
      }

      calculateSnapTargets(index, preferredScrollSlots = null, shiftOnEdgeClick = false) {
        const clampedIndex = Math.max(0, Math.min(this.totalItems - 1, index));

        if (this.maxScrollSlots === 0) {
          return {
            reelX: 0,
            lensX: clampedIndex * this.itemWidth,
            clampedIndex
          };
        }

        let scrollSlots = preferredScrollSlots !== null
          ? preferredScrollSlots
          : Math.round(-this.currReelX / this.itemWidth);

        if (clampedIndex < scrollSlots) {
          scrollSlots = clampedIndex;
        } else if (clampedIndex > scrollSlots + this.visibleCount - 1) {
          scrollSlots = clampedIndex - (this.visibleCount - 1);
        }

        if (shiftOnEdgeClick) {
          if (clampedIndex === scrollSlots + this.visibleCount - 1 && scrollSlots < this.maxScrollSlots) {
            scrollSlots += 1;
          } else if (clampedIndex === scrollSlots && scrollSlots > 0) {
            scrollSlots -= 1;
          }
        }

        scrollSlots = Math.max(0, Math.min(this.maxScrollSlots, scrollSlots));

        const reelX    = -(scrollSlots * this.itemWidth);
        const lensSlot = clampedIndex - scrollSlots;
        const lensX    = lensSlot * this.itemWidth;

        return { reelX, lensX, clampedIndex };
      }

      updateFades(reelX) {
        if (!this.fadeLeft || !this.fadeRight) return;

        let nextLeft  = '0';
        let nextRight = '0';

        if (this.maxScrollSlots > 0) {
          const maxScrollPx = -(this.maxScrollSlots * this.itemWidth);
          nextLeft  = reelX < -4 ? '1' : '0';
          nextRight = reelX > (maxScrollPx + 4) ? '1' : '0';
        }

        if (this.lastFadeLeft !== nextLeft) {
          this.lastFadeLeft = nextLeft;
          this.fadeLeft.style.opacity = nextLeft;
        }
        if (this.lastFadeRight !== nextRight) {
          this.lastFadeRight = nextRight;
          this.fadeRight.style.opacity = nextRight;
        }
      }

      updateUnderLensHighlight() {
        const lensReelCenter = (this.currLensX - this.currReelX) / this.itemWidth;
        const currentSlot    = Math.max(0, Math.min(this.totalItems - 1, Math.round(lensReelCenter)));

        const slotChanged = currentSlot !== this.lastUnderLensSlot;
        if (slotChanged) {
          this.lastUnderLensSlot = currentSlot;
        }

        for (let idx = 0; idx < this.totalItems; idx++) {
          const item = this.items[idx];

          if (slotChanged) {
            const isUnder = idx === currentSlot;
            item.classList.toggle('under-lens', isUnder);
            item.setAttribute('aria-selected', isUnder ? 'true' : 'false');
          }

          let scaleStr = '1';
          if (this.isInteracting) {
            const dist = Math.abs(idx - lensReelCenter);
            if (dist < 1) {
              const proximity = 1 - dist;
              scaleStr = (1 + 0.12 * Math.pow(proximity, 1.5)).toFixed(4);
            }
          }

          if (this.lastItemScales[idx] !== scaleStr) {
            this.lastItemScales[idx] = scaleStr;
            item.style.setProperty('--item-scale', scaleStr);
          }
        }

        if (this.isDragging && this.timeIndicator && currentSlot !== this.lastDisplayedSlot) {
          this.lastDisplayedSlot = currentSlot;
          if (this.items[currentSlot]) {
            this.timeIndicator.textContent = `Vybráno: ${this.items[currentSlot].dataset.time}`;
          }
        }
      }

      setInteracting(state) {
        state = state && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.isInteracting = state;
        this.control.classList.toggle('is-interacting', state);
        if (!state) {
          for (let idx = 0; idx < this.totalItems; idx++) {
            if (this.lastItemScales[idx] !== '1') {
              this.lastItemScales[idx] = '1';
              this.items[idx].style.setProperty('--item-scale', '1');
            }
          }
        }
      }

      updateEdgeAutoScrollAndStretch() {
        const maxLensX    = this.itemWidth * (this.visibleCount - 1);
        const maxScrollPx = -(this.maxScrollSlots * this.itemWidth);

        const rawX = this.lastPointerX - this.cachedRect.left - 4 - this.itemWidth / 2;

        this.autoScrollSpeed = 0;

        if (this.maxScrollSlots > 0) {
          const edgeZone = this.itemWidth * 0.85;

          if (rawX > maxLensX - edgeZone) {
            if (this.targetReelX > maxScrollPx) {
              const intensity = Math.min(1.40, (rawX - (maxLensX - edgeZone)) / (this.itemWidth * 0.65));
              this.autoScrollSpeed = -intensity * (this.itemWidth * 3.9);
            }
          } else if (rawX < edgeZone) {
            if (this.targetReelX < 0) {
              const intensity = Math.min(1.40, (edgeZone - rawX) / (this.itemWidth * 0.65));
              this.autoScrollSpeed = intensity * (this.itemWidth * 3.9);
            }
          }
        }

        let overscrollPx = 0;
        if (rawX < 0 && this.targetReelX >= -0.5) {
          overscrollPx = rawX;
        } else if (rawX > maxLensX && this.targetReelX <= maxScrollPx + 0.5) {
          overscrollPx = rawX - maxLensX;
        }

        const clampedLensX = Math.max(0, Math.min(rawX, maxLensX));
        const pullX = Math.abs(Math.tanh(overscrollPx / 38));

        this.targetBarX  = Math.tanh(overscrollPx / 34) * this.maxBarShiftX;
        this.targetLensX = clampedLensX + Math.tanh(overscrollPx / 22) * this.maxLensOverrunX;

        return pullX;
      }

      startHoldLoop() {
        cancelAnimationFrame(this.holdRafId);
        this.lastFrameTime = performance.now();

        const loop = (now) => {
          if (!this.pointerDown) return;

          const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
          this.lastFrameTime = now;

          if (this.isDragging) {
            this.updateEdgeAutoScrollAndStretch();

            if (this.autoScrollSpeed !== 0) {
              const maxScrollPx = -(this.maxScrollSlots * this.itemWidth);
              this.targetReelX += this.autoScrollSpeed * dt;
              if (this.targetReelX < maxScrollPx) {
                this.targetReelX = maxScrollPx;
              } else if (this.targetReelX > 0) {
                this.targetReelX = 0;
              }
            }
          }

          const deltaSum =
            Math.abs(this.targetLensX      - this.currLensX) +
            Math.abs(this.targetReelX      - this.currReelX) +
            Math.abs(this.targetLensY      - this.currLensY) +
            Math.abs(this.targetBarX       - this.barX) +
            Math.abs(this.targetBarY       - this.barY) +
            Math.abs(this.targetBarScaleX  - this.barScaleX) * 100 +
            Math.abs(this.targetBarScaleY  - this.barScaleY) * 100 +
            Math.abs(this.targetLensScaleX - this.lensScaleX) * 100 +
            Math.abs(this.targetLensScaleY - this.lensScaleY) * 100;

          if (deltaSum > 0.01 || this.autoScrollSpeed !== 0) {
            this.currLensX  = this.damp(this.currLensX,  this.targetLensX,      35, dt);
            this.currReelX  = this.damp(this.currReelX,  this.targetReelX,      27, dt);
            this.currLensY  = this.damp(this.currLensY,  this.targetLensY,      29, dt);
            this.barX       = this.damp(this.barX,       this.targetBarX,       29, dt);
            this.barY       = this.damp(this.barY,       this.targetBarY,       29, dt);
            this.barScaleX  = this.damp(this.barScaleX,  this.targetBarScaleX,  29, dt);
            this.barScaleY  = this.damp(this.barScaleY,  this.targetBarScaleY,  29, dt);
            this.lensScaleX = this.damp(this.lensScaleX, this.targetLensScaleX, 29, dt);
            this.lensScaleY = this.damp(this.lensScaleY, this.targetLensScaleY, 29, dt);

            this.render();
            this.updateUnderLensHighlight();
          }

          this.holdRafId = requestAnimationFrame(loop);
        };
        this.holdRafId = requestAnimationFrame(loop);
      }

      animateTo(targetLensX, targetReelX, durationMs, edgeBumpDir = 0, swellBar = false) {
        cancelAnimationFrame(this.rafId);
        cancelAnimationFrame(this.holdRafId);

        this.animFromLensX = this.currLensX;
        this.animToLensX   = targetLensX;
        this.animFromReelX = this.currReelX;
        this.animToReelX   = targetReelX;

        this.animFromY          = this.currLensY;
        this.animFromBarX       = this.barX;
        this.animFromBarY       = this.barY;
        this.animFromBarScaleX  = this.barScaleX;
        this.animFromBarScaleY  = this.barScaleY;
        this.animFromLensScaleX = this.lensScaleX;
        this.animFromLensScaleY = this.lensScaleY;
        this.edgeNudgeDir       = edgeBumpDir;

        this.animDuration  = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : durationMs;
        this.animStartTime = performance.now();

        const step = (now) => {
          const elapsed  = now - this.animStartTime;
          const progress = Math.min(1, elapsed / this.animDuration);
          const eased    = this.easeOutGlide(progress);
          const sinWave  = Math.sin(progress * Math.PI);

          const lensOverrunWave = this.edgeNudgeDir * sinWave * 2.8;
          this.currLensX = this.animFromLensX + (this.animToLensX - this.animFromLensX) * eased + lensOverrunWave;
          this.currReelX = this.animFromReelX + (this.animToReelX - this.animFromReelX) * eased;
          this.currLensY = this.animFromY * (1 - eased);

          const barBumpWave = this.edgeNudgeDir * sinWave * (this.maxBarShiftX * 0.7);
          const liftWave    = swellBar ? sinWave * this.pressBarLiftY : 0;
          this.barX = this.animFromBarX * (1 - eased) + barBumpWave;
          this.barY = this.animFromBarY * (1 - eased) + liftWave;

          const swellX     = swellBar ? sinWave * (this.pressBarScaleX - 1) : 0;
          const swellY     = swellBar ? sinWave * (this.pressBarScaleY - 1) : 0;
          const lensSwellX = swellBar ? sinWave * (this.pressLensScaleX - 1) : 0;
          const lensSwellY = swellBar ? sinWave * (this.pressLensScaleY - 1) : 0;

          this.barScaleX  = 1 + (this.animFromBarScaleX  - 1) * (1 - eased) + swellX;
          this.barScaleY  = 1 + (this.animFromBarScaleY  - 1) * (1 - eased) + swellY;
          this.lensScaleX = 1 + (this.animFromLensScaleX - 1) * (1 - eased) + lensSwellX;
          this.lensScaleY = 1 + (this.animFromLensScaleY - 1) * (1 - eased) + lensSwellY;

          this.render();
          this.updateUnderLensHighlight();

          if (progress < 1) {
            this.rafId = requestAnimationFrame(step);
          } else {
            this.currLensX   = this.animToLensX;
            this.currReelX   = this.animToReelX;
            this.targetLensX = this.animToLensX;
            this.targetReelX = this.animToReelX;
            this.resetTransformState();
            this.render();
            this.updateUnderLensHighlight();
            this.rafId = null;
          }
        };

        this.rafId = requestAnimationFrame(step);
      }

      render() {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          this.barX = this.barY = this.currY = this.currLensY = 0;
          this.barScaleX = this.barScaleY = this.lensScaleX = this.lensScaleY = 1;
        }
        this.track.style.transform   = `translate3d(${this.currLensX.toFixed(2)}px, ${this.currLensY.toFixed(2)}px, 0)`;
        this.reel.style.transform    = `translate3d(${this.currReelX.toFixed(2)}px, 0, 0)`;
        this.control.style.transform = `translate3d(${this.barX.toFixed(2)}px, ${this.barY.toFixed(2)}px, 0) scale3d(${this.barScaleX.toFixed(4)}, ${this.barScaleY.toFixed(4)}, 1)`;
        this.lensBody.style.setProperty('--stretch-x', this.lensScaleX.toFixed(4));
        this.lensBody.style.setProperty('--stretch-y', this.lensScaleY.toFixed(4));
        this.updateFades(this.currReelX);
      }

      glideToIndex(index) {
        clearTimeout(this.collapseTimer);
        this.measure();

        const distanceSlots = Math.abs(index - this.activeIndex);
        const duration = distanceSlots === 0 ? 220 : 240 + distanceSlots * 35;

        let edgeBumpDir = 0;
        if (index === 0 && this.activeIndex !== 0) edgeBumpDir = -1;
        if (index === this.totalItems - 1 && this.activeIndex !== this.totalItems - 1) edgeBumpDir = 1;

        const needSwell = this.barScaleY < 1.02;

        this.setInteracting(true);
        this.selectSegment(index, duration, edgeBumpDir, needSwell, true);

        this.collapseTimer = setTimeout(() => {
          this.setInteracting(false);
        }, duration - 30);
      }

      onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        if (this.pointerDown) return;

        this.measure();
        cancelAnimationFrame(this.rafId);
        clearTimeout(this.collapseTimer);

        this.pointerDown     = true;
        this.activePointerId = e.pointerId;
        this.isDragging      = false;
        this.autoScrollSpeed = 0;
        this.startX          = e.clientX;
        this.startY          = e.clientY;
        this.lastPointerX    = e.clientX;

        this.targetLensX      = this.currLensX;
        this.targetReelX      = this.currReelX;
        this.targetLensY      = 0;
        this.targetBarX       = 0;
        this.targetBarY       = this.pressBarLiftY;
        this.targetBarScaleX  = this.pressBarScaleX;
        this.targetBarScaleY  = this.pressBarScaleY;
        this.targetLensScaleX = this.pressLensScaleX;
        this.targetLensScaleY = this.pressLensScaleY;

        this.setInteracting(true);
        this.updateUnderLensHighlight();
        this.startHoldLoop();
      }

      onPointerMove(e) {
        if (!this.pointerDown || e.pointerId !== this.activePointerId) return;

        const dx = e.clientX - this.startX;
        const dy = e.clientY - this.startY;
        this.lastPointerX = e.clientX;

        if (!this.isDragging && Math.hypot(dx, dy) > 4) {
          this.isDragging = true;
        }
        if (!this.isDragging) return;

        const pullX = this.updateEdgeAutoScrollAndStretch();

        const centerY  = this.cachedRect.top + this.cachedRect.height / 2;
        const rawY     = Math.max(0, e.clientY - centerY);
        const pullDown = Math.abs(Math.tanh(rawY / 55));

        this.targetBarY  = this.pressBarLiftY + (pullDown * this.maxBarShiftY);
        this.targetLensY = pullDown * this.maxLensShiftY;

        this.targetBarScaleX  = this.pressBarScaleX - (pullDown * this.maxBarNarrowX) + (pullX * 0.012);
        this.targetBarScaleY  = this.pressBarScaleY + (pullDown * this.maxBarStretchY) - (pullX * 0.018);

        this.targetLensScaleX = this.pressLensScaleX * (1 - (pullDown * 0.038) + (pullX * 0.045));
        this.targetLensScaleY = this.pressLensScaleY * (1 + (pullDown * 0.055) - (pullX * 0.030));
      }

      onPointerUp(e) {
        if (!this.pointerDown) return;
        if (e && e.pointerId !== undefined && e.pointerId !== this.activePointerId) return;

        this.pointerDown     = false;
        this.activePointerId = null;
        this.autoScrollSpeed = 0;
        cancelAnimationFrame(this.holdRafId);

        if (this.isDragging) {
          const lensReelCenter    = (this.currLensX - this.currReelX) / this.itemWidth;
          const targetIndex       = Math.max(0, Math.min(this.totalItems - 1, Math.round(lensReelCenter)));
          const nearestScrollSlot = Math.max(0, Math.min(this.maxScrollSlots, Math.round(-this.currReelX / this.itemWidth)));

          this.selectSegment(targetIndex, 240, 0, false, false, nearestScrollSlot);
          setTimeout(() => { this.isDragging = false; }, 40);
        } else {
          const { reelX, lensX } = this.calculateSnapTargets(this.activeIndex);
          this.animateTo(lensX, reelX, 200, 0, false);
        }

        this.collapseTimer = setTimeout(() => {
          this.setInteracting(false);
        }, 170);
      }

      selectSegment(index, duration = 260, edgeBumpDir = 0, swellBar = false, shiftOnEdgeClick = false, preferredScrollSlots = null) {
        const changed = this.activeIndex !== index;
        this.activeIndex = index;
        const { reelX, lensX } = this.calculateSnapTargets(index, preferredScrollSlots, shiftOnEdgeClick);
        this.animateTo(lensX, reelX, duration, edgeBumpDir, swellBar);

        const item = this.items[index];
        const selectedTime = item.dataset.time;
        const selectedCode = item.dataset.code || String(index);

        this.lastDisplayedSlot = index;
        if (this.timeIndicator) {
          this.timeIndicator.textContent = `Vybráno: ${selectedTime}`;
        }

        updateUrlParam(this.urlKey || 'time', selectedCode);

        if (changed) {
          window.dispatchEvent(new CustomEvent('meteo:timechange', {
            detail: { index, code: selectedCode, label: selectedTime }
          }));
        }
      }
    }

    /* ==========================================================================
       SPODNÍ NAVIGACE — 4 Sekce (Aktuálně, Grafy, Statistiky, Rekordy)
       ========================================================================== */
    class SmoothLiquidNav {
      constructor() {
        this.tabbar   = document.getElementById('liquidTabbar');
        this.track    = document.getElementById('lensTrack');
        this.lensBody = document.getElementById('lensBody');
        this.items    = Array.from(this.tabbar.querySelectorAll('.nav-item'));
        this.pages    = Array.from(document.querySelectorAll('.page'));

        this.activeIndex     = 0;
        this.isDragging      = false;
        this.pointerDown     = false;
        this.activePointerId = null;
        this.isInteracting   = false;
        this.cachedRect      = null;
        this.itemWidth       = 0;

        try {
          const urlTab = new URLSearchParams(window.location.search).get('tab');
          if (urlTab) {
            const foundIdx = this.items.findIndex(item => item.dataset.tab === urlTab);
            if (foundIdx !== -1) this.activeIndex = foundIdx;
          }
        } catch (_) {}

        this.lastUnderLensSlot = -1;
        this.lastItemScales    = new Array(this.items.length).fill('1');

        this.currX      = 0;
        this.currY      = 0;
        this.lensScaleX = 1;
        this.lensScaleY = 1;

        this.barX      = 0;
        this.barY      = 0;
        this.barScaleX = 1;
        this.barScaleY = 1;

        this.pressBarScaleX  = 1.03;
        this.pressBarScaleY  = 1.05;
        this.pressBarLiftY   = -1.2;
        this.pressLensScaleX = 1.14;
        this.pressLensScaleY = 1.26;

        this.maxBarShiftX    = 5.5;
        this.maxBarShiftY    = 1.8;
        this.maxLensShiftY   = 1.8;
        this.maxLensOverrunX = 3.5;

        this.maxBarNarrowX  = 0.038;
        this.maxBarStretchY = 0.048;

        this.targetLensX      = 0;
        this.targetLensY      = 0;
        this.targetBarX       = 0;
        this.targetBarY       = 0;
        this.targetBarScaleX  = 1;
        this.targetBarScaleY  = 1;
        this.targetLensScaleX = 1;
        this.targetLensScaleY = 1;

        this.lastFrameTime = 0;
        this.startX        = 0;
        this.startY        = 0;

        this.animFromX          = 0;
        this.animToX            = 0;
        this.animFromY          = 0;
        this.animFromBarX       = 0;
        this.animFromBarY       = 0;
        this.animFromBarScaleX  = 1;
        this.animFromBarScaleY  = 1;
        this.animFromLensScaleX = 1;
        this.animFromLensScaleY = 1;
        this.edgeNudgeDir       = 0;

        this.animStartTime = 0;
        this.animDuration  = 300;

        this.rafId         = null;
        this.holdRafId     = null;
        this.collapseTimer = null;

        this.init();
      }

      init() {
        this.measure();
        this.currX       = this.activeIndex * this.itemWidth;
        this.targetLensX = this.currX;
        this.render();
        this.updateUnderLensHighlight(this.currX);
        this.activatePageDom(this.activeIndex);

        this.resizeObserver = new ResizeObserver(() => {
          if (this.pointerDown) return;
          this.resetTransformState();
          this.measure();
          this.currX       = this.activeIndex * this.itemWidth;
          this.targetLensX = this.currX;
          this.render();
          this.updateUnderLensHighlight(this.currX);
        });
        this.resizeObserver.observe(this.tabbar);

        this.items.forEach((item, index) => {
          item.addEventListener('click', () => {
            if (this.isDragging) return;
            this.glideToIndex(index);
          });
        });

        this.tabbar.addEventListener('contextmenu', (e) => e.preventDefault());

        this.tabbar.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        window.addEventListener('pointermove',   (e) => this.onPointerMove(e), { passive: true });
        window.addEventListener('pointerup',     (e) => this.onPointerUp(e),   { passive: true });
        window.addEventListener('pointercancel', (e) => this.onPointerUp(e),   { passive: true });

        window.addEventListener('blur', () => this.forceCancelInteraction(), { passive: true });
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) this.forceCancelInteraction();
        });
      }

      damp(current, target, speed, dt) {
        return current + (target - current) * (1 - Math.exp(-speed * dt));
      }

      resetTransformState() {
        this.currY      = 0;
        this.barX       = 0;
        this.barY       = 0;
        this.barScaleX  = 1;
        this.barScaleY  = 1;
        this.lensScaleX = 1;
        this.lensScaleY = 1;
      }

      forceCancelInteraction() {
        if (this.pointerDown) {
          this.onPointerUp({ pointerId: this.activePointerId });
        }
      }

      measure() {
        const width  = this.tabbar.offsetWidth;
        const height = this.tabbar.offsetHeight;
        const rect   = this.tabbar.getBoundingClientRect();

        const originX = rect.left + rect.width * 0.5 - this.barX;
        const originY = rect.top  + rect.height * 0.85 - this.barY;

        this.cachedRect = {
          left:   originX - width * 0.5,
          top:    originY - height * 0.85,
          width:  width,
          height: height
        };
        this.itemWidth = (width - 10) / this.items.length;
      }

      easeOutGlide(t) {
        return 1 - Math.pow(1 - t, 3.2);
      }

      updateUnderLensHighlight(xPos) {
        const currentSlot = Math.max(0, Math.min(this.items.length - 1, Math.round(xPos / this.itemWidth)));
        const lensCenter  = xPos / this.itemWidth;

        const slotChanged = currentSlot !== this.lastUnderLensSlot;
        if (slotChanged) {
          this.lastUnderLensSlot = currentSlot;
        }

        for (let idx = 0; idx < this.items.length; idx++) {
          const item = this.items[idx];

          if (slotChanged) {
            const isUnder = idx === currentSlot;
            item.classList.toggle('under-lens', isUnder);
            item.setAttribute('aria-selected', isUnder ? 'true' : 'false');
          }

          let scaleStr = '1';
          if (this.isInteracting) {
            const dist = Math.abs(idx - lensCenter);
            if (dist < 1) {
              const proximity = 1 - dist;
              scaleStr = (1 + 0.13 * Math.pow(proximity, 1.5)).toFixed(4);
            }
          }

          if (this.lastItemScales[idx] !== scaleStr) {
            this.lastItemScales[idx] = scaleStr;
            item.style.setProperty('--item-scale', scaleStr);
          }
        }
      }

      setInteracting(state) {
        state = state && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.isInteracting = state;
        this.tabbar.classList.toggle('is-interacting', state);
        if (!state) {
          for (let idx = 0; idx < this.items.length; idx++) {
            if (this.lastItemScales[idx] !== '1') {
              this.lastItemScales[idx] = '1';
              this.items[idx].style.setProperty('--item-scale', '1');
            }
          }
        }
      }

      startHoldLoop() {
        cancelAnimationFrame(this.holdRafId);
        this.lastFrameTime = performance.now();

        const loop = (now) => {
          if (!this.pointerDown) return;

          const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
          this.lastFrameTime = now;

          const deltaSum =
            Math.abs(this.targetLensX      - this.currX) +
            Math.abs(this.targetLensY      - this.currY) +
            Math.abs(this.targetBarX       - this.barX) +
            Math.abs(this.targetBarY       - this.barY) +
            Math.abs(this.targetBarScaleX  - this.barScaleX) * 100 +
            Math.abs(this.targetBarScaleY  - this.barScaleY) * 100 +
            Math.abs(this.targetLensScaleX - this.lensScaleX) * 100 +
            Math.abs(this.targetLensScaleY - this.lensScaleY) * 100;

          if (deltaSum > 0.01) {
            this.currX      = this.damp(this.currX,      this.targetLensX,      33, dt);
            this.currY      = this.damp(this.currY,      this.targetLensY,      29, dt);
            this.barX       = this.damp(this.barX,       this.targetBarX,       29, dt);
            this.barY       = this.damp(this.barY,       this.targetBarY,       29, dt);
            this.barScaleX  = this.damp(this.barScaleX,  this.targetBarScaleX,  29, dt);
            this.barScaleY  = this.damp(this.barScaleY,  this.targetBarScaleY,  29, dt);
            this.lensScaleX = this.damp(this.lensScaleX, this.targetLensScaleX, 29, dt);
            this.lensScaleY = this.damp(this.lensScaleY, this.targetLensScaleY, 29, dt);

            this.render();
            this.updateUnderLensHighlight(this.currX);
          }

          this.holdRafId = requestAnimationFrame(loop);
        };
        this.holdRafId = requestAnimationFrame(loop);
      }

      animateTo(targetX, durationMs, edgeBumpDir = 0, swellBar = false) {
        cancelAnimationFrame(this.rafId);
        cancelAnimationFrame(this.holdRafId);

        this.animFromX          = this.currX;
        this.animToX            = targetX;
        this.animFromY          = this.currY;
        this.animFromBarX       = this.barX;
        this.animFromBarY       = this.barY;
        this.animFromBarScaleX  = this.barScaleX;
        this.animFromBarScaleY  = this.barScaleY;
        this.animFromLensScaleX = this.lensScaleX;
        this.animFromLensScaleY = this.lensScaleY;
        this.edgeNudgeDir       = edgeBumpDir;

        this.animDuration  = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : durationMs;
        this.animStartTime = performance.now();

        const step = (now) => {
          const elapsed  = now - this.animStartTime;
          const progress = Math.min(1, elapsed / this.animDuration);
          const eased    = this.easeOutGlide(progress);
          const sinWave  = Math.sin(progress * Math.PI);

          const lensOverrunWave = this.edgeNudgeDir * sinWave * 2.8;
          this.currX = this.animFromX + (this.animToX - this.animFromX) * eased + lensOverrunWave;
          this.currY = this.animFromY * (1 - eased);

          const barBumpWave = this.edgeNudgeDir * sinWave * (this.maxBarShiftX * 0.7);
          const liftWave    = swellBar ? sinWave * this.pressBarLiftY : 0;
          this.barX = this.animFromBarX * (1 - eased) + barBumpWave;
          this.barY = this.animFromBarY * (1 - eased) + liftWave;

          const swellX     = swellBar ? sinWave * (this.pressBarScaleX - 1) : 0;
          const swellY     = swellBar ? sinWave * (this.pressBarScaleY - 1) : 0;
          const lensSwellX = swellBar ? sinWave * (this.pressLensScaleX - 1) : 0;
          const lensSwellY = swellBar ? sinWave * (this.pressLensScaleY - 1) : 0;

          this.barScaleX  = 1 + (this.animFromBarScaleX  - 1) * (1 - eased) + swellX;
          this.barScaleY  = 1 + (this.animFromBarScaleY  - 1) * (1 - eased) + swellY;
          this.lensScaleX = 1 + (this.animFromLensScaleX - 1) * (1 - eased) + lensSwellX;
          this.lensScaleY = 1 + (this.animFromLensScaleY - 1) * (1 - eased) + lensSwellY;

          this.render();
          this.updateUnderLensHighlight(this.currX);

          if (progress < 1) {
            this.rafId = requestAnimationFrame(step);
          } else {
            this.currX       = this.animToX;
            this.targetLensX = this.animToX;
            this.resetTransformState();
            this.render();
            this.updateUnderLensHighlight(this.currX);
            this.rafId = null;
          }
        };

        this.rafId = requestAnimationFrame(step);
      }

      render() {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          this.barX = this.barY = this.currY = this.currLensY = 0;
          this.barScaleX = this.barScaleY = this.lensScaleX = this.lensScaleY = 1;
        }
        this.track.style.transform  = `translate3d(${this.currX.toFixed(2)}px, ${this.currY.toFixed(2)}px, 0)`;
        this.tabbar.style.transform = `translate3d(${this.barX.toFixed(2)}px, ${this.barY.toFixed(2)}px, 0) scale3d(${this.barScaleX.toFixed(4)}, ${this.barScaleY.toFixed(4)}, 1)`;
        this.lensBody.style.setProperty('--stretch-x', this.lensScaleX.toFixed(4));
        this.lensBody.style.setProperty('--stretch-y', this.lensScaleY.toFixed(4));
      }

      glideToIndex(index) {
        clearTimeout(this.collapseTimer);
        this.measure();

        const distanceSlots = Math.abs(index - this.activeIndex);
        const duration = distanceSlots === 0 ? 240 : 255 + distanceSlots * 65;

        let edgeBumpDir = 0;
        if (index === 0 && this.activeIndex !== 0) edgeBumpDir = -1;
        if (index === this.items.length - 1 && this.activeIndex !== this.items.length - 1) edgeBumpDir = 1;

        const needSwell = this.barScaleY < 1.02;

        this.setInteracting(true);
        this.selectSection(index, duration, edgeBumpDir, needSwell);

        this.collapseTimer = setTimeout(() => {
          this.setInteracting(false);
        }, duration - 30);
      }

      onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        if (this.pointerDown) return;

        this.measure();
        cancelAnimationFrame(this.rafId);
        clearTimeout(this.collapseTimer);

        this.pointerDown     = true;
        this.activePointerId = e.pointerId;
        this.isDragging      = false;
        this.startX          = e.clientX;
        this.startY          = e.clientY;

        this.targetLensX      = this.currX;
        this.targetLensY      = 0;
        this.targetBarX       = 0;
        this.targetBarY       = this.pressBarLiftY;
        this.targetBarScaleX  = this.pressBarScaleX;
        this.targetBarScaleY  = this.pressBarScaleY;
        this.targetLensScaleX = this.pressLensScaleX;
        this.targetLensScaleY = this.pressLensScaleY;

        this.setInteracting(true);
        this.updateUnderLensHighlight(this.currX);
        this.startHoldLoop();
      }

      onPointerMove(e) {
        if (!this.pointerDown || e.pointerId !== this.activePointerId) return;

        const dx = e.clientX - this.startX;
        const dy = e.clientY - this.startY;

        if (!this.isDragging && Math.hypot(dx, dy) > 4) {
          this.isDragging = true;
        }
        if (!this.isDragging) return;

        const maxOffset = this.itemWidth * (this.items.length - 1);
        const rawX      = e.clientX - this.cachedRect.left - 5 - this.itemWidth / 2;
        const clampedX  = Math.max(0, Math.min(rawX, maxOffset));

        let overscrollX = 0;
        if (rawX < 0) overscrollX = rawX;
        else if (rawX > maxOffset) overscrollX = rawX - maxOffset;

        const pullX = Math.abs(Math.tanh(overscrollX / 48));
        this.targetBarX  = Math.tanh(overscrollX / 44) * this.maxBarShiftX;
        this.targetLensX = clampedX + Math.tanh(overscrollX / 26) * this.maxLensOverrunX;

        const centerY = this.cachedRect.top + this.cachedRect.height / 2;
        const rawY    = Math.min(0, e.clientY - centerY);
        const pullUp  = Math.abs(Math.tanh(rawY / 65));

        this.targetBarY  = this.pressBarLiftY - (pullUp * this.maxBarShiftY);
        this.targetLensY = -pullUp * this.maxLensShiftY;

        this.targetBarScaleX = this.pressBarScaleX - (pullUp * this.maxBarNarrowX) + (pullX * 0.015);
        this.targetBarScaleY = this.pressBarScaleY + (pullUp * this.maxBarStretchY) - (pullX * 0.022);

        this.targetLensScaleX = this.pressLensScaleX * (1 - (pullUp * 0.045) + (pullX * 0.045));
        this.targetLensScaleY = this.pressLensScaleY * (1 + (pullUp * 0.065) - (pullX * 0.035));
      }

      onPointerUp(e) {
        if (!this.pointerDown) return;
        if (e && e.pointerId !== undefined && e.pointerId !== this.activePointerId) return;

        this.pointerDown     = false;
        this.activePointerId = null;
        cancelAnimationFrame(this.holdRafId);

        if (this.isDragging) {
          const targetIndex = Math.max(0, Math.min(this.items.length - 1, Math.round(this.currX / this.itemWidth)));
          this.selectSection(targetIndex, 260, 0, false);
          setTimeout(() => { this.isDragging = false; }, 40);
        } else {
          this.animateTo(this.activeIndex * this.itemWidth, 220, 0, false);
        }

        this.collapseTimer = setTimeout(() => {
          this.setInteracting(false);
        }, 180);
      }

      activatePageDom(index) {
        const targetId = this.items[index].dataset.target;
        this.pages.forEach((page) => {
          page.classList.toggle('active', page.id === targetId);
        });
      }

      selectSection(index, duration = 300, edgeBumpDir = 0, swellBar = false) {
        const changed = this.activeIndex !== index;
        this.activeIndex = index;
        this.animateTo(index * this.itemWidth, duration, edgeBumpDir, swellBar);

        this.activatePageDom(index);

        const item = this.items[index];
        const tabCode = item.dataset.tab || String(index);
        updateUrlParam('tab', tabCode);

        if (changed) {
          window.dispatchEvent(new CustomEvent('meteo:sectionchange', {
            detail: { index, tab: tabCode, targetId: item.dataset.target }
          }));
        }
      }
    }

    /* ==========================================================================
       LIQUID GLASS ON/OFF SWITCH
       ========================================================================== */
    class LiquidSwitch {
      constructor(elementId) {
        this.control  = document.getElementById(elementId);
        this.track    = this.control.querySelector('.switch-lens-track');
        this.lensBody = this.control.querySelector('.switch-lens-body');

        this.isOn            = false;
        this.isDragging      = false;
        this.pointerDown     = false;
        this.activePointerId = null;
        this.isInteracting   = false;
        this.cachedRect      = null;
        this.maxOffset       = 0;

        this.currX      = 0;
        this.currY      = 0;
        this.lensScaleX = 1;
        this.lensScaleY = 1;

        this.barX      = 0;
        this.barY      = 0;
        this.barScaleX = 1;
        this.barScaleY = 1;

        this.pressBarScaleX  = 1.02;
        this.pressBarScaleY  = 1.03;
        this.pressBarLiftY   = -0.6;
        this.pressLensScaleX = 1.54;
        this.pressLensScaleY = 1.58;

        this.maxBarShiftX    = 4.5;
        this.maxBarShiftY    = 1.6;
        this.maxLensShiftY   = 1.6;
        this.maxLensOverrunX = 4.5;

        this.maxBarNarrowX   = 0.035;
        this.maxBarStretchY  = 0.042;

        this.targetLensX      = 0;
        this.targetLensY      = 0;
        this.targetBarX       = 0;
        this.targetBarY       = 0;
        this.targetBarScaleX  = 1;
        this.targetBarScaleY  = 1;
        this.targetLensScaleX = 1;
        this.targetLensScaleY = 1;

        this.lastFrameTime = 0;
        this.startX        = 0;
        this.startY        = 0;

        this.animFromX          = 0;
        this.animToX            = 0;
        this.animFromY          = 0;
        this.animFromBarX       = 0;
        this.animFromBarY       = 0;
        this.animFromBarScaleX  = 1;
        this.animFromBarScaleY  = 1;
        this.animFromLensScaleX = 1;
        this.animFromLensScaleY = 1;
        this.edgeNudgeDir       = 0;

        this.animStartTime = 0;
        this.animDuration  = 260;

        this.rafId         = null;
        this.holdRafId     = null;
        this.collapseTimer = null;

        this.init();
      }

      init() {
        this.measure();
        this.currX       = this.isOn ? this.maxOffset : 0;
        this.targetLensX = this.currX;
        this.render();
        this.updateVisualState(this.currX);

        this.control.addEventListener('click', () => {
          if (this.isDragging) return;
          this.glideToState(!this.isOn);
        });

        this.control.addEventListener('contextmenu', (e) => e.preventDefault());

        this.control.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        window.addEventListener('pointermove',   (e) => this.onPointerMove(e), { passive: true });
        window.addEventListener('pointerup',     (e) => this.onPointerUp(e),   { passive: true });
        window.addEventListener('pointercancel', (e) => this.onPointerUp(e),   { passive: true });

        window.addEventListener('blur', () => this.forceCancelInteraction(), { passive: true });
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) this.forceCancelInteraction();
        });
      }

      damp(current, target, speed, dt) {
        return current + (target - current) * (1 - Math.exp(-speed * dt));
      }

      easeOutGlide(t) {
        return 1 - Math.pow(1 - t, 3.2);
      }

      resetTransformState() {
        this.currY      = 0;
        this.barX       = 0;
        this.barY       = 0;
        this.barScaleX  = 1;
        this.barScaleY  = 1;
        this.lensScaleX = 1;
        this.lensScaleY = 1;
      }

      forceCancelInteraction() {
        if (this.pointerDown) {
          this.onPointerUp({ pointerId: this.activePointerId });
        }
      }

      measure() {
        const width      = this.control.offsetWidth;
        const height     = this.control.offsetHeight;
        const thumbWidth = this.track.offsetWidth;
        const rect       = this.control.getBoundingClientRect();

        const originX = rect.left + rect.width * 0.5 - this.barX;
        const originY = rect.top  + rect.height * 0.5 - this.barY;

        this.cachedRect = {
          left:        originX - width * 0.5,
          top:         originY - height * 0.5,
          width:       width,
          height:      height,
          thumbWidth:  thumbWidth
        };

        this.maxOffset = width - 4 - thumbWidth;
      }

      updateVisualState(xPos) {
        const isCurrentlyOn = xPos >= this.maxOffset * 0.5;
        this.control.classList.toggle('is-on', isCurrentlyOn);
        this.control.setAttribute('aria-checked', isCurrentlyOn ? 'true' : 'false');
      }

      setInteracting(state) {
        state = state && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.isInteracting = state;
        this.control.classList.toggle('is-interacting', state);
      }

      startHoldLoop() {
        cancelAnimationFrame(this.holdRafId);
        this.lastFrameTime = performance.now();

        const loop = (now) => {
          if (!this.pointerDown) return;

          const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
          this.lastFrameTime = now;

          const deltaSum =
            Math.abs(this.targetLensX      - this.currX) +
            Math.abs(this.targetLensY      - this.currY) +
            Math.abs(this.targetBarX       - this.barX) +
            Math.abs(this.targetBarY       - this.barY) +
            Math.abs(this.targetBarScaleX  - this.barScaleX) * 100 +
            Math.abs(this.targetBarScaleY  - this.barScaleY) * 100 +
            Math.abs(this.targetLensScaleX - this.lensScaleX) * 100 +
            Math.abs(this.targetLensScaleY - this.lensScaleY) * 100;

          if (deltaSum > 0.01) {
            this.currX      = this.damp(this.currX,      this.targetLensX,      34, dt);
            this.currY      = this.damp(this.currY,      this.targetLensY,      29, dt);
            this.barX       = this.damp(this.barX,       this.targetBarX,       29, dt);
            this.barY       = this.damp(this.barY,       this.targetBarY,       29, dt);
            this.barScaleX  = this.damp(this.barScaleX,  this.targetBarScaleX,  29, dt);
            this.barScaleY  = this.damp(this.barScaleY,  this.targetBarScaleY,  29, dt);
            this.lensScaleX = this.damp(this.lensScaleX, this.targetLensScaleX, 29, dt);
            this.lensScaleY = this.damp(this.lensScaleY, this.targetLensScaleY, 29, dt);

            this.render();
            this.updateVisualState(this.currX);
          }

          this.holdRafId = requestAnimationFrame(loop);
        };
        this.holdRafId = requestAnimationFrame(loop);
      }

      animateTo(targetX, durationMs, edgeBumpDir = 0, swellBar = false) {
        cancelAnimationFrame(this.rafId);
        cancelAnimationFrame(this.holdRafId);

        this.animFromX          = this.currX;
        this.animToX            = targetX;
        this.animFromY          = this.currY;
        this.animFromBarX       = this.barX;
        this.animFromBarY       = this.barY;
        this.animFromBarScaleX  = this.barScaleX;
        this.animFromBarScaleY  = this.barScaleY;
        this.animFromLensScaleX = this.lensScaleX;
        this.animFromLensScaleY = this.lensScaleY;
        this.edgeNudgeDir       = edgeBumpDir;

        this.animDuration  = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : durationMs;
        this.animStartTime = performance.now();

        const step = (now) => {
          const elapsed  = now - this.animStartTime;
          const progress = Math.min(1, elapsed / this.animDuration);
          const eased    = this.easeOutGlide(progress);
          const sinWave  = Math.sin(progress * Math.PI);

          const lensOverrunWave = this.edgeNudgeDir * sinWave * 2.5;
          this.currX = this.animFromX + (this.animToX - this.animFromX) * eased + lensOverrunWave;
          this.currY = this.animFromY * (1 - eased);

          const barBumpWave = this.edgeNudgeDir * sinWave * (this.maxBarShiftX * 0.65);
          const liftWave    = swellBar ? sinWave * this.pressBarLiftY : 0;
          this.barX = this.animFromBarX * (1 - eased) + barBumpWave;
          this.barY = this.animFromBarY * (1 - eased) + liftWave;

          const swellX     = swellBar ? sinWave * (this.pressBarScaleX - 1) : 0;
          const swellY     = swellBar ? sinWave * (this.pressBarScaleY - 1) : 0;
          const lensSwellX = swellBar ? sinWave * (this.pressLensScaleX - 1) : 0;
          const lensSwellY = swellBar ? sinWave * (this.pressLensScaleY - 1) : 0;

          this.barScaleX  = 1 + (this.animFromBarScaleX  - 1) * (1 - eased) + swellX;
          this.barScaleY  = 1 + (this.animFromBarScaleY  - 1) * (1 - eased) + swellY;
          this.lensScaleX = 1 + (this.animFromLensScaleX - 1) * (1 - eased) + lensSwellX;
          this.lensScaleY = 1 + (this.animFromLensScaleY - 1) * (1 - eased) + lensSwellY;

          this.render();
          this.updateVisualState(this.currX);

          if (progress < 1) {
            this.rafId = requestAnimationFrame(step);
          } else {
            this.currX       = this.animToX;
            this.targetLensX = this.animToX;
            this.resetTransformState();
            this.render();
            this.updateVisualState(this.currX);
            this.rafId = null;
          }
        };

        this.rafId = requestAnimationFrame(step);
      }

      render() {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          this.barX = this.barY = this.currY = this.currLensY = 0;
          this.barScaleX = this.barScaleY = this.lensScaleX = this.lensScaleY = 1;
        }
        this.track.style.transform   = `translate3d(${this.currX.toFixed(2)}px, ${this.currY.toFixed(2)}px, 0)`;
        this.control.style.transform = `translate3d(${this.barX.toFixed(2)}px, ${this.barY.toFixed(2)}px, 0) scale3d(${this.barScaleX.toFixed(4)}, ${this.barScaleY.toFixed(4)}, 1)`;
        this.lensBody.style.setProperty('--stretch-x', this.lensScaleX.toFixed(4));
        this.lensBody.style.setProperty('--stretch-y', this.lensScaleY.toFixed(4));
      }

      glideToState(nextState) {
        clearTimeout(this.collapseTimer);
        this.measure();

        const duration    = 280;
        const edgeBumpDir = nextState ? 1 : -1;
        const needSwell   = this.lensScaleY < 1.15;

        this.setInteracting(true);
        this.setState(nextState, duration, edgeBumpDir, needSwell);

        this.collapseTimer = setTimeout(() => {
          this.setInteracting(false);
        }, duration - 30);
      }

      onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        if (this.pointerDown) return;

        this.measure();
        cancelAnimationFrame(this.rafId);
        clearTimeout(this.collapseTimer);

        this.pointerDown     = true;
        this.activePointerId = e.pointerId;
        this.isDragging      = false;
        this.startX          = e.clientX;
        this.startY          = e.clientY;

        this.targetLensX      = this.currX;
        this.targetLensY      = 0;
        this.targetBarX       = 0;
        this.targetBarY       = this.pressBarLiftY;
        this.targetBarScaleX  = this.pressBarScaleX;
        this.targetBarScaleY  = this.pressBarScaleY;
        this.targetLensScaleX = this.pressLensScaleX;
        this.targetLensScaleY = this.pressLensScaleY;

        this.setInteracting(true);
        this.startHoldLoop();
      }

      onPointerMove(e) {
        if (!this.pointerDown || e.pointerId !== this.activePointerId) return;

        const dx = e.clientX - this.startX;
        const dy = e.clientY - this.startY;

        if (!this.isDragging && Math.hypot(dx, dy) > 4) {
          this.isDragging = true;
        }
        if (!this.isDragging) return;

        const rawX     = e.clientX - this.cachedRect.left - 2 - this.cachedRect.thumbWidth / 2;
        const clampedX = Math.max(0, Math.min(rawX, this.maxOffset));

        let overscrollX = 0;
        if (rawX < 0) overscrollX = rawX;
        else if (rawX > this.maxOffset) overscrollX = rawX - this.maxOffset;

        const pullX = Math.abs(Math.tanh(overscrollX / 36));
        this.targetBarX  = Math.tanh(overscrollX / 32) * this.maxBarShiftX;
        this.targetLensX = clampedX + Math.tanh(overscrollX / 20) * this.maxLensOverrunX;

        const centerY = this.cachedRect.top + this.cachedRect.height / 2;
        const rawY    = e.clientY - centerY;
        const pullY   = Math.abs(Math.tanh(rawY / 50));

        this.targetBarY  = this.pressBarLiftY + Math.tanh(rawY / 50) * this.maxBarShiftY;
        this.targetLensY = Math.tanh(rawY / 50) * this.maxLensShiftY;

        this.targetBarScaleX = this.pressBarScaleX - (pullY * this.maxBarNarrowX) + (pullX * 0.015);
        this.targetBarScaleY = this.pressBarScaleY + (pullY * this.maxBarStretchY) - (pullX * 0.020);

        this.targetLensScaleX = this.pressLensScaleX * (1 - (pullY * 0.040) + (pullX * 0.065));
        this.targetLensScaleY = this.pressLensScaleY * (1 + (pullY * 0.055) - (pullX * 0.035));
      }

      onPointerUp(e) {
        if (!this.pointerDown) return;
        if (e && e.pointerId !== undefined && e.pointerId !== this.activePointerId) return;

        this.pointerDown     = false;
        this.activePointerId = null;
        cancelAnimationFrame(this.holdRafId);

        if (this.isDragging) {
          const nextState = this.currX >= this.maxOffset * 0.5;
          this.setState(nextState, 240, 0, false);
          setTimeout(() => { this.isDragging = false; }, 40);
        } else {
          this.animateTo(this.isOn ? this.maxOffset : 0, 200, 0, false);
        }

        this.collapseTimer = setTimeout(() => {
          this.setInteracting(false);
        }, 170);
      }

      setState(nextState, duration = 260, edgeBumpDir = 0, swellBar = false) {
        const changed = this.isOn !== nextState;
        this.isOn = nextState;
        const targetX = this.isOn ? this.maxOffset : 0;

        this.animateTo(targetX, duration, edgeBumpDir, swellBar);

        if (changed) {
          window.dispatchEvent(new CustomEvent('switch:change', {
            detail: { checked: this.isOn }
          }));
        }
      }
    }

    /* Aktuálně — vstup WeatherStation.accept(payload) pro budoucí adaptér.
       measuredAt je čas skutečného měření; receivedAt vzniká při jeho přijetí.
       Hodnoty: outsideC, insideC, outsideHumidity, insideHumidity, pressure,
       wind, rain a dryPeriod. Chybějící hodnoty se předávají jako null.
       Tlak vyžaduje druh absolute/seaLevel, srážky doložené intervaly a den
       v Europe/Prague, suché období doložené pokrytí historie.
       Metody setLoading, setError a setUnavailable spravují stav bez měření.
    */
    const WeatherData = (() => {
      const TZ = 'Europe/Prague';
      const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' });
      function pragueDay(ms) {
        const parts = Object.fromEntries(dayFormatter.formatToParts(ms).map(p => [p.type,p.value]));
        return `${parts.year}-${parts.month}-${parts.day}`;
      }
      function timestamp(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value !== 'string') return null;
        const ms = Date.parse(value);
        return Number.isFinite(ms) && ms <= Date.now() + 60000 ? ms : null;
      }
      function number(value, min = -Infinity, max = Infinity) {
        return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
      }
      function normalize(payload = {}) {
        const measuredAt = timestamp(payload.measuredAt) ?? (payload.timestamp ? payload.timestamp * 1000 : Date.now());
        const hour = payload.rain?.hour;
        const day = payload.rain?.day;
        const from = timestamp(hour?.from), to = timestamp(hour?.to);
        const hourComplete = measuredAt !== null && hour?.complete === true && from !== null && to !== null && Math.abs(to-measuredAt) <= 1000 && Math.abs(to-from-3600000) <= 1000;
        const dayComplete = measuredAt !== null && day?.complete === true && day?.timeZone === TZ && day?.date === pragueDay(measuredAt);
        const dry = payload.dryPeriod;
        const lastRainAt = timestamp(dry?.lastRainAt);
        const coverageStart = timestamp(dry?.coverageStart), coverageEnd = timestamp(dry?.coverageEnd);
        const dryComplete = measuredAt !== null && dry?.complete === true && lastRainAt !== null && lastRainAt <= measuredAt && coverageStart !== null && coverageStart <= lastRainAt && coverageEnd !== null && coverageEnd >= measuredAt;
        const pressureKind = ['absolute','seaLevel'].includes(payload.pressure?.kind) ? payload.pressure.kind : (payload.pressureKind || 'seaLevel');
        const rainHour = payload.rainHour != null ? number(payload.rainHour,0) : (hourComplete ? number(hour.valueMm,0) : null);
        const rainDay = payload.rainDay != null ? number(payload.rainDay,0) : (dayComplete ? number(day.valueMm,0) : null);
        const dryConsistent = dryComplete && !(rainHour > 0 && measuredAt-lastRainAt >= 3600000) && !(rainDay > 0 && pragueDay(lastRainAt) !== pragueDay(measuredAt));
        const dryDays = payload.dryDays != null ? number(payload.dryDays,0) : (dryConsistent ? Math.floor((measuredAt-lastRainAt)/86400000) : null);
        return {
          measuredAt, sourceUpdatedAt: timestamp(payload.sourceUpdatedAt) ?? Date.now(),
          outsideC: number(payload.outsideC), insideC: number(payload.insideC),
          outsideHumidity: number(payload.outsideHumidity,0,100), insideHumidity: number(payload.insideHumidity,0,100),
          pressureHpa: payload.pressureHpa != null ? number(payload.pressureHpa,1) : number(payload.pressure?.valueHpa,1), pressureKind,
          speedMps: payload.speedMps != null ? number(payload.speedMps,0) : number(payload.wind?.speedMps,0),
          directionDeg: payload.directionDeg != null ? number(payload.directionDeg,0,360) : number(payload.wind?.directionDeg,0,360),
          rainHour, rainDay, rainDate: payload.rainDate ?? (dayComplete ? day.date : pragueDay(measuredAt)),
          dryDays,
          lastRainAt: payload.lastRainAt != null ? timestamp(payload.lastRainAt) : (dryConsistent ? lastRainAt : null)
        };
      }
      function currentDayRain(data,now=Date.now()) { return data?.rainDay ?? null; }
      return { normalize, timestamp, pragueDay, currentDayRain };
    })();

    class CurrentWeatherStore extends EventTarget {
      constructor() {
        super();
        this.state = { status:'unavailable', data:null, receivedAt:null, message:null };
        this.staleAfterMs = 15*60*1000;
      }
      publish(patch) { Object.assign(this.state,patch); this.dispatchEvent(new Event('change')); }
      accept(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Očekáván datový objekt.');
        const data = WeatherData.normalize(payload);
        this.publish({ status:'ready', data, receivedAt:Date.now(), message:null });
      }
      loading() { this.publish({ status:'loading', message:null }); }
      error(message) { this.publish({ status:'error', message: typeof message === 'string' ? message : null }); }
      unavailable() { this.publish({ status:'unavailable', data:null, receivedAt:null, message:null }); }
      isStale(now = Date.now()) { return this.state.data?.measuredAt != null && now-this.state.data.measuredAt > this.staleAfterMs; }
    }

    class CurrentWeatherView {
      constructor(store) {
        this.store = store;
        this.formatDate = new Intl.DateTimeFormat('cs-CZ',{ timeZone:'Europe/Prague', day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' });
        this.formatNumber = new Intl.NumberFormat('cs-CZ',{ minimumFractionDigits:1,maximumFractionDigits:1,useGrouping:false });
        this.integerNumber = new Intl.NumberFormat('cs-CZ',{maximumFractionDigits:0});
        store.addEventListener('change',() => this.render());
        this.render();
        this.relativeTimer = setInterval(() => { if (!document.hidden) this.render(); },30000);
        document.addEventListener('visibilitychange',() => { if (!document.hidden) this.render(); });
      }
      text(id,value) { const el = document.getElementById(id); if (el) el.textContent = value; }
      relative(ms,now = Date.now()) {
        if (ms === null) return '';
        const seconds = Math.max(0,Math.floor((now-ms)/1000));
        if (seconds < 60) return 'před méně než minutou';
        const minutes = Math.floor(seconds/60);
        if (minutes < 60) return minutes === 1 ? 'před 1 minutou' : `před ${minutes} minutami`;
        const hours = Math.floor(minutes/60);
        if (hours < 24) return hours === 1 ? 'před 1 hodinou' : `před ${hours} hodinami`;
        const days = Math.floor(hours/24);
        return days === 1 ? 'před 1 dnem' : `před ${days} dny`;
      }
      time(id,ms,empty) {
        const el = document.getElementById(id);
        el.textContent = ms === null ? empty : this.formatDate.format(ms);
        if (ms === null) el.removeAttribute('datetime'); else el.dateTime = new Date(ms).toISOString();
      }
      value(id,value,integer = false) {
        const el = document.getElementById(id);
        el.textContent = value == null ? '—' : (integer ? this.integerNumber : this.formatNumber).format(value);
        el.classList.toggle('is-missing',value == null);
        el.setAttribute('aria-label',value == null ? 'Údaj není dostupný' : el.textContent);
      }
      card(id,values) {
        const { status } = this.store.state;
        const any = values.some(v => v != null), all = values.every(v => v != null);
        const ageUnknown = this.store.state.data?.measuredAt == null;
        const stale = this.store.isStale();
        const node = document.querySelector(`#card-${id} .card-state`);
        node.textContent = !any ? (status === 'loading' ? 'Načítání' : 'Bez údaje') : !all ? 'Část údajů chybí' : status === 'error' || status === 'loading' ? 'Poslední dostupné' : stale ? 'Starší údaj' : ageUnknown ? 'Čas neznámý' : 'Měření';
        node.dataset.state = stale && any ? 'stale' : status;
      }
      render() {
        const { status,data:d,receivedAt,message } = this.store.state;
        const data = { ...(d || {}) };
        data.rainDay = WeatherData.currentDayRain(d);
        const stale = this.store.isStale();
        let statusText = 'Data nejsou připojena', tone = 'neutral';
        let detail = 'Stanice zatím není připojena. Zobrazí se zde skutečně naměřené hodnoty, jakmile budou k dispozici.';
        if (status === 'loading') { statusText = 'Načítání dat'; detail = 'Čekáme na nové údaje. Čas posledního měření se změní až s přijetím dalšího měření.'; }
        if (status === 'error') { statusText = 'Data nejsou dostupná'; tone = 'warning'; detail = message || (d ? 'Nové údaje se nepodařilo načíst. Zobrazeno je poslední dostupné měření.' : 'Údaje se nepodařilo načíst. Chybějící hodnoty nejsou nulová měření.'); }
        if (status === 'ready') {
          const missing = ['outsideC','insideC','outsideHumidity','insideHumidity','pressureHpa','speedMps','directionDeg','rainHour','rainDay','dryDays'].some(key => data[key] == null);
          if (data.measuredAt == null) { statusText = 'Čas měření není znám'; tone = 'warning'; detail = 'Čas měření nebyl předán v ověřitelném formátu. Stáří zobrazených údajů nelze určit.'; }
          else if (stale) { statusText = 'Zastaralé údaje'; tone = 'warning'; detail = 'Poslední měření je starší než nastavený limit. Hodnoty nemusejí odpovídat současnému počasí.'; }
          else { statusText = missing ? 'Některé údaje chybí' : 'Měření je aktuální'; tone = missing ? 'neutral' : 'success'; detail = missing ? 'Dostupné hodnoty jsou zobrazené. Pomlčka znamená chybějící nebo neověřený údaj, nikoli nulu.' : 'Čas měření pochází ze stanice. Čas načtení zaznamenává samostatně přijetí údajů do tohoto webu.'; }
        }
        this.text('statusText',statusText); const ds = document.getElementById('dataStatus'); if (ds) ds.dataset.tone = tone;
        this.text('dataMessage',detail);
        this.text('measuredLabel','Poslední měření');
        this.text('loadedLabel','Poslední načtení dat');
        this.time('measuredTime',data.measuredAt ?? null,status === 'loading' ? 'Čekáme na měření' : 'Zatím není dostupné');
        this.time('loadedTime',receivedAt,'Data dosud nebyla načtena');
        this.text('measuredRelative',data.measuredAt != null ? this.relative(data.measuredAt) : 'Čas měření neznáme');
        this.text('loadedRelative',receivedAt != null ? `${this.relative(receivedAt)} · pražský čas` : 'Časové pásmo Europe/Prague');
        const grid = document.getElementById('weatherGrid'); grid.setAttribute('aria-busy',String(status === 'loading')); grid.dataset.loading = String(status === 'loading');
        for (const [id,key,integer] of [ ['outValue','outsideC'],['inValue','insideC'],['outHumidity','outsideHumidity',true],['inHumidity','insideHumidity',true],['pressureValue','pressureHpa'],['windValue','speedMps'],['rainHourValue','rainHour'],['rainDayValue','rainDay'],['dryValue','dryDays',true] ]) this.value(id,data[key],integer);
        this.card('outdoor',[data.outsideC]); this.card('indoor',[data.insideC]);
        this.card('humidity-out',[data.outsideHumidity]); this.card('humidity-in',[data.insideHumidity]);
        this.card('pressure',[data.pressureHpa]); this.card('wind',[data.speedMps,data.directionDeg]);
        this.card('rain',[data.rainHour,data.rainDay]); this.card('dry',[data.dryDays]);
        this.text('outNote',data.outsideC == null ? 'Čeká na venkovní měření' : 'Teplota venkovního vzduchu');
        this.text('inNote',data.insideC == null ? 'Čeká na vnitřní měření' : 'Teplota vnitřního vzduchu');
        this.text('outHumidityNote',data.outsideHumidity == null ? 'Relativní vlhkost není dostupná' : 'Relativní vlhkost venkovního vzduchu');
        this.text('inHumidityNote',data.insideHumidity == null ? 'Relativní vlhkost není dostupná' : 'Relativní vlhkost vnitřního vzduchu');
        this.text('pressureNote',data.pressureHpa == null ? 'Typ a hodnota tlaku nejsou dostupné' : data.pressureKind === 'absolute' ? 'Absolutní tlak' : data.pressureKind === 'seaLevel' ? 'Relativní tlak' : 'Typ tlaku nebyl uveden');
        let windText = data.speedMps == null ? 'Rychlost a směr nejsou dostupné' : 'Směr není dostupný';
        if (data.directionDeg != null) {
          const directions = ['S','SSV','SV','VSV','V','VJV','JV','JJV','J','JJZ','JZ','ZJZ','Z','ZSZ','SZ','SSZ'];
          const degree = data.directionDeg % 360;
          windText = `${Math.round(degree)}° · ${directions[Math.round(degree/22.5)%16]}`;
        }
        this.text('windNote',windText);
        const arrow = document.getElementById('windArrow'); arrow.toggleAttribute('hidden',data.directionDeg == null);
        arrow.style.transform = `rotate(${data.directionDeg ?? 0}deg)`;
        this.text('rainNote',data.rainDay != null ? `Denní úhrn: ${new Intl.DateTimeFormat('cs-CZ',{timeZone:'Europe/Prague',day:'numeric',month:'numeric',year:'numeric'}).format(data.measuredAt)}` : 'Denní úhrn od 00:00');
        this.text('dryNote',data.lastRainAt != null ? `Poslední déšť: ${this.formatDate.format(data.lastRainAt)}` : 'Bez souvislé historie nelze určit');
        this.text('dryUnit',data.dryDays === 1 ? 'den' : data.dryDays >= 2 && data.dryDays <= 4 ? 'dny' : 'dní');
        for (const [id,key] of [['outThermo','outsideC'],['inThermo','insideC']]) document.getElementById(id).style.height = data[key] == null ? '0%' : `${Math.max(0,Math.min(100,(data[key]+20)/70*100))}%`;
        for (const [id,key] of [['outRing','outsideHumidity'],['inRing','insideHumidity']]) document.getElementById(id).style.strokeDashoffset = data[key] == null ? '126' : String(126*(1-data[key]/100));
        const needle = document.getElementById('pressureNeedle'); needle.style.visibility = data.pressureHpa == null ? 'hidden' : 'visible';
        needle.style.transform = `rotate(${Math.max(-80,Math.min(80,((data.pressureHpa ?? 1013)-1013)/50*80))}deg)`;
      }
    }

    function initializeCurrentPage(switchControl,nav,carousel) {
      const store = new CurrentWeatherStore();
      new CurrentWeatherView(store);
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      let explicitTheme = null;
      try { const saved = localStorage.getItem('weather-station-theme'); if (['light','dark'].includes(saved)) explicitTheme = saved; } catch (_) {}
      const initialTheme = explicitTheme || (mq.matches ? 'dark' : 'light');
      function applyTheme(theme) { document.documentElement.dataset.theme = theme; document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#080a0d' : '#f2f3f5'; }
      applyTheme(initialTheme);
      // Bez změnové události při inicializaci. Původní fyzika přepínače zůstává zachována.
      switchControl.isOn = initialTheme === 'dark';
      switchControl.currX = switchControl.isOn ? switchControl.maxOffset : 0;
      switchControl.targetLensX = switchControl.currX; switchControl.render(); switchControl.updateVisualState(switchControl.currX);
      window.addEventListener('switch:change',event => { explicitTheme = event.detail.checked ? 'dark' : 'light'; applyTheme(explicitTheme); try { localStorage.setItem('weather-station-theme',explicitTheme); } catch (_) {} });
      mq.addEventListener('change',event => { if (explicitTheme) return; applyTheme(event.matches ? 'dark' : 'light'); switchControl.isOn = event.matches; switchControl.measure(); switchControl.currX = event.matches ? switchControl.maxOffset : 0; switchControl.targetLensX = switchControl.currX; switchControl.render(); switchControl.updateVisualState(switchControl.currX); });
      const switchResize = new ResizeObserver(() => { if (switchControl.pointerDown) return; switchControl.measure(); switchControl.currX = switchControl.isOn ? switchControl.maxOffset : 0; switchControl.targetLensX = switchControl.currX; switchControl.render(); });
      switchResize.observe(switchControl.control);
      function syncSection() {
        const item = nav.items[nav.activeIndex]; document.body.dataset.section = item.dataset.tab;
        nav.items.forEach((node,i) => node.tabIndex = i === nav.activeIndex ? 0 : -1);
      }
      syncSection();
      window.addEventListener('meteo:sectionchange',() => { syncSection(); window.scrollTo({top:0,behavior:'instant'}); });
      // Klávesnice doplňuje původní ovládání kliknutím a tažením.
      function keys(control,items,select,current) {
        control.addEventListener('keydown',event => {
          let index = current();
          if (event.key === 'ArrowRight') index = (index+1)%items.length;
          else if (event.key === 'ArrowLeft') index = (index-1+items.length)%items.length;
          else if (event.key === 'Home') index = 0;
          else if (event.key === 'End') index = items.length-1;
          else return;
          event.preventDefault(); select(index); items[index].focus({preventScroll:document.body.dataset.section==='statistiky' && control===carousel.control});
        });
      }
      keys(nav.tabbar,nav.items,i => nav.glideToIndex(i),() => nav.activeIndex);
      keys(carousel.control,carousel.items,i => carousel.glideToIndex(i),() => carousel.activeIndex);
      // Jediný veřejný vstup pro budoucí adaptér; vrací kopii, ne živý stav.
      window.WeatherStation = Object.freeze({
        accept:payload => store.accept(payload), setLoading:() => store.loading(),
        setError:message => store.error(message), setUnavailable:() => store.unavailable(),
        getState:() => JSON.parse(JSON.stringify(store.state)),
        configure:options => { if (Number.isFinite(options?.staleAfterMs) && options.staleAfterMs > 0) { store.staleAfterMs = options.staleAfterMs; store.publish({}); } }
      });
    }

    /* Grafy — WeatherHistory.accept(payload) přijímá samostatné časové řady.
       payload obsahuje pressureKind a series; každá řada je pole {time,value}
       nebo objekt {points,maxGapMs}. time vyžaduje explicitní časové pásmo,
       value je konečné číslo nebo null pro chybějící měření.
       Jednotky a veličiny určuje HISTORY_SERIES, nikoli výchozí naměřená data.
       Datová vrstva neprovádí síťové požadavky a nevytváří měření.
    */
    const HISTORY_PERIODS = Object.freeze({ '1h':3600000,'24h':86400000,'7d':7*86400000,'30d':30*86400000,'60d':60*86400000,'90d':90*86400000,'180d':180*86400000,'1y':365*86400000,all:null });
    const HISTORY_SERIES = Object.freeze({
      outsideC:{label:'Venkovní teplota',unit:'°C',color:'orange'},
      feelsLikeC:{label:'Pocitová teplota',unit:'°C',color:'peach'},
      dewPointC:{label:'Rosný bod',unit:'°C',color:'teal'},
      insideC:{label:'Vnitřní teplota',unit:'°C',color:'peach'},
      outsideHumidity:{label:'Venkovní vlhkost',unit:'%',color:'blue',min:0,max:100},
      insideHumidity:{label:'Vnitřní vlhkost',unit:'%',color:'indigo',min:0,max:100},
      pressureHpa:{label:'Atmosférický tlak',unit:'hPa',color:'green',min:1},
      windMps:{label:'Rychlost větru',unit:'m/s',color:'teal',min:0},
      gustMps:{label:'Nárazy větru',unit:'m/s',color:'indigo',min:0},
      rainRateMmh:{label:'Intenzita srážek',unit:'mm/h',color:'cyan',min:0}
    });
    const HISTORY_CHARTS = [
      {id:'outside',title:'Venkovní teplota',icon:'outdoor',keys:['outsideC','feelsLikeC','dewPointC'],hero:true},
      {id:'inside',title:'Vnitřní teplota',icon:'indoor',keys:['insideC']},
      {id:'humidity-out',title:'Venkovní vlhkost',icon:'drop',keys:['outsideHumidity'],humidity:true},
      {id:'humidity-in',title:'Vnitřní vlhkost',icon:'indoor-drop',keys:['insideHumidity'],humidity:true},
      {id:'pressure',title:'Atmosférický tlak',icon:'pressure',keys:['pressureHpa'],pressure:true},
      {id:'wind',title:'Vítr',icon:'wind',keys:['windMps','gustMps'],zero:true},
      {id:'rain',title:'Intenzita srážek',icon:'rain',keys:['rainRateMmh'],zero:true,area:true}
    ];

    const HistoryMath = (() => {
      function timestamp(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value !== 'string') return null;
        const t=Date.parse(value); return Number.isFinite(t) && t<=Date.now()+60000 ? t : null;
      }
      function normalize(payload) {
        if (!payload || typeof payload!=='object' || Array.isArray(payload)) throw new TypeError('Historie musí být objekt.');
        const series={}; let first=null,last=null,latestValueAt=null,total=0;
        for (const [key,def] of Object.entries(HISTORY_SERIES)) {
          const input=payload.series?.[key];
          const raw=Array.isArray(input) ? input : input?.points;
          const byTime=new Map();
          if (Array.isArray(raw)) for (const point of raw) {
            if (!point || typeof point!=='object') continue;
            const t=timestamp(point.time ?? point.t); if (t===null) continue;
            const v=point.value !== undefined ? point.value : point.v;
            const value=typeof v==='number' && Number.isFinite(v) && v>=(def.min??-Infinity) && v<=(def.max??Infinity) ? v : null;
            byTime.set(t,{t,v:value});
          }
          const points=[...byTime.values()].sort((a,b)=>a.t-b.t);
          const maxGapMs=Number.isFinite(input?.maxGapMs) && input.maxGapMs>0 ? input.maxGapMs : null;
          series[key]={points,maxGapMs};
          if (points.length) { first=first===null?points[0].t:Math.min(first,points[0].t); last=last===null?points.at(-1).t:Math.max(last,points.at(-1).t); }
          for (let i=points.length-1;i>=0;i--) if(points[i].v!==null){ latestValueAt=latestValueAt===null?points[i].t:Math.max(latestValueAt,points[i].t); break; }
          total+=points.length;
        }
        return {series,first,last,latestValueAt,total,pressureKind:['absolute','seaLevel'].includes(payload.pressureKind)?payload.pressureKind:'unknown'};
      }
      function lowerBound(points,time) { let lo=0,hi=points.length; while(lo<hi){const mid=(lo+hi)>>>1; if(points[mid].t<time)lo=mid+1;else hi=mid;}return lo; }
      function slice(points,from,to) { const start=lowerBound(points,from);let end=lowerBound(points,to);if(points[end]?.t===to)end++;return points.slice(start,end); }
      function range(code,data,now=Date.now()) {
        if (code==='all') { const to=data?.last??now,from=data?.first??(to-86400000);return {from,to,code}; }
        return {from:now-(HISTORY_PERIODS[code]??HISTORY_PERIODS['24h']),to:now,code};
      }
      // Nejvýše čtyři původní body na časový koš: první, minimum, maximum, poslední.
      // ID souvislého úseku zabrání propojení přes null a známé časové výpadky.
      function simplify(points,from,to,bucketCount,maxGapMs=null) {
        const count=Math.max(1,Math.floor(bucketCount)),span=Math.max(1,to-from),buckets=new Map();
        let run=0,previous=null;
        for (const p of points) {
          if (p.v===null) { run++;previous=null;continue; }
          if(previous!==null && maxGapMs!==null && p.t-previous>maxGapMs)run++;
          const item={...p,run}; previous=p.t;
          const k=Math.min(count-1,Math.max(0,Math.floor((p.t-from)/span*count)));
          let b=buckets.get(k);
          if(!b){b={first:item,min:item,max:item,last:item};buckets.set(k,b);}
          else { b.last=item;if(p.v<b.min.v)b.min=item;if(p.v>b.max.v)b.max=item; }
        }
        const result=[];
        for(const b of buckets.values()){
          const items=[...new Map([b.first,b.min,b.max,b.last].map(p=>[p.t,p])).values()].sort((a,b)=>a.t-b.t);
          result.push(...items);
        }
        return result;
      }
      function stats(points) { let min=Infinity,max=-Infinity,last=null,count=0;for(const p of points)if(p.v!==null){min=Math.min(min,p.v);max=Math.max(max,p.v);last=p;count++;}return{min:count?min:null,max:count?max:null,last,count}; }
      function nearest(points,time,maxGapMs=null) {
        if(!points.length)return null;
        const i=lowerBound(points,time),a=points[Math.max(0,i-1)],b=points[Math.min(points.length-1,i)];
        const p=Math.abs(a.t-time)<=Math.abs(b.t-time)?a:b;
        return p.v===null || (maxGapMs!==null && Math.abs(p.t-time)>maxGapMs/2) ? null : p;
      }
      function scale(min,max,options={}) {
        if(options.humidity)return{min:0,max:100,ticks:[0,25,50,75,100]};
        if(min===null || max===null)return{min:0,max:1,ticks:[]};
        let low=min,high=max;
        const span=Math.max(high-low,options.pressure?2:1);
        low-=span*.12;high+=span*.12;
        if(options.zero)low=0;
        if(high<=low)high=low+1;
        const raw=(high-low)/4,base=10**Math.floor(Math.log10(raw)),fraction=raw/base;
        const step=(fraction<=1?1:fraction<=2?2:fraction<=2.5?2.5:fraction<=5?5:10)*base;
        low=Math.floor(low/step)*step;high=Math.ceil(high/step)*step;
        if(options.zero)low=0;
        const ticks=[];for(let x=low;x<=high+step*.01 && ticks.length<12;x+=step)ticks.push(Math.abs(x)<1e-9?0:x);
        return{min:low,max:high,ticks};
      }
      return{timestamp,normalize,lowerBound,slice,range,simplify,stats,nearest,scale};
    })();

    class HistoryStore extends EventTarget {
      constructor(){super();this.state={status:'unavailable',data:null,receivedAt:null,message:null};this.staleAfterMs=900000;}
      publish(patch){Object.assign(this.state,patch);this.dispatchEvent(new Event('change'));}
      accept(payload) { const data=HistoryMath.normalize(payload);this.publish({status:'ready',data,receivedAt:Date.now(),message:null}); }
      loading(){this.publish({status:'loading',message:null});}
      error(message){this.publish({status:'error',message:typeof message==='string'?message:null});}
      unavailable(){this.publish({status:'unavailable',data:null,receivedAt:null,message:null});}
      isStale(now=Date.now()){return this.state.data?.latestValueAt!=null && now-this.state.data.latestValueAt>this.staleAfterMs;}
    }


    /* Malý SVG renderer časových řad. Žádné externí knihovny ani CDN; funguje i offline. */
    class GlassHistoryChart {
      constructor(def,controller){
        this.def=def;this.owner=controller;this.element=document.getElementById(`history-${def.id}`);
        this.frame=this.element.querySelector('.plot-frame');this.svg=this.element.querySelector('.plot-svg');
        this.tooltip=this.element.querySelector('.plot-tooltip');this.empty=this.element.querySelector('.plot-empty');
        this.hidden=new Set();this.ranged={};this.range=null;this.drawCount=0;this.width=0;this.cursorTime=null;
        this.legendButtons=new Map();
        for(const key of def.keys){
          const info=HISTORY_SERIES[key],button=document.createElement('button');button.type='button';button.className='legend-button';button.style.setProperty('--series-color',`var(--plot-${info.color})`);button.setAttribute('aria-pressed','true');button.setAttribute('aria-label',`${info.label}: zobrazit nebo skrýt řadu`);
          const mark=document.createElement('span');mark.className='legend-mark';mark.setAttribute('aria-hidden','true');
          const name=document.createElement('span');name.textContent=info.label;button.append(mark,name);
          const unavailable=document.createElement('small');unavailable.textContent='bez dat';button.append(unavailable);
          button.addEventListener('click',()=>{if(this.hidden.has(key))this.hidden.delete(key);else this.hidden.add(key);this.draw();});
          this.element.querySelector('.chart-legend').append(button);this.legendButtons.set(key,{button,unavailable});
        }
        let isScrubbing = false;
        let startX = 0;
        let startY = 0;
        let isHorizontalDrag = false;

        const onStart = (clientX, clientY) => {
          isScrubbing = true;
          startX = clientX;
          startY = clientY ?? 0;
          isHorizontalDrag = false;
          this.handleCoords(clientX, true);
        };

        const onMove = (clientX, clientY, event) => {
          if (!isScrubbing && event?.pointerType !== 'mouse') return;
          if (clientY !== undefined && !isHorizontalDrag) {
            const dx = Math.abs(clientX - startX);
            const dy = Math.abs(clientY - startY);
            if (dx > 6 && dx > dy) {
              isHorizontalDrag = true;
            }
          }
          if (isHorizontalDrag && event && event.cancelable) {
            event.preventDefault();
          }
          this.handleCoords(clientX, false);
        };

        const onEnd = (isMouse) => {
          isScrubbing = false;
          isHorizontalDrag = false;
          if (isMouse) this.hideTooltip();
        };

        // Pointer Events pro myš, pero a dotyková pera
        this.frame.addEventListener('pointerdown', event => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          try { this.frame.setPointerCapture(event.pointerId); } catch (_) {}
          onStart(event.clientX, event.clientY);
        });

        this.frame.addEventListener('pointermove', event => {
          if (event.pointerType === 'mouse' || isScrubbing) {
            onMove(event.clientX, event.clientY, event);
          }
        });

        this.frame.addEventListener('pointerup', event => {
          try { this.frame.releasePointerCapture(event.pointerId); } catch (_) {}
          onEnd(event.pointerType === 'mouse');
        });

        this.frame.addEventListener('pointercancel', event => {
          try { this.frame.releasePointerCapture(event.pointerId); } catch (_) {}
          onEnd(event.pointerType === 'mouse');
        });

        this.frame.addEventListener('pointerleave', event => {
          if (event.pointerType === 'mouse' && !isScrubbing) this.hideTooltip();
        });

        // Dedikované touch události pro mobilní telefony
        this.frame.addEventListener('touchstart', event => {
          if (event.touches && event.touches.length === 1) {
            onStart(event.touches[0].clientX, event.touches[0].clientY);
          }
        }, { passive: true });

        this.frame.addEventListener('touchmove', event => {
          if (event.touches && event.touches.length === 1) {
            onMove(event.touches[0].clientX, event.touches[0].clientY, event);
          }
        }, { passive: false });

        this.frame.addEventListener('touchend', () => {
          onEnd(false);
        }, { passive: true });

        this.frame.addEventListener('touchcancel', () => {
          onEnd(false);
        }, { passive: true });

        this.svg.addEventListener('blur', () => this.hideTooltip());
        this.svg.addEventListener('keydown', event => this.keyboard(event));
        new ResizeObserver(entries=>{const width=Math.round(entries[0].contentRect.width);if(width>0 && width!==this.width && this.owner.isActive()){this.width=width;this.draw();}}).observe(this.frame);
      }
      node(tag,attributes={},text){const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attributes))el.setAttribute(k,String(v));if(text!==undefined)el.textContent=text;return el;}
      setData(range){this.range=range;const data=this.owner.store.state.data;for(const key of this.def.keys){const input=data?.series[key];this.ranged[key]={points:input?HistoryMath.slice(input.points,range.from,range.to):[],maxGapMs:input?.maxGapMs??null};}this.draw();}
      draw(){
        if(!this.range || !this.owner.isActive())return;
        const width=Math.round(this.frame.clientWidth);if(width<1)return;this.width=width;this.drawCount++;
        this.hideTooltip();this.svg.replaceChildren();this.svg.setAttribute('viewBox',`0 0 ${width} ${this.frame.clientHeight}`);
        this.svg.dataset.from=String(this.range.from);this.svg.dataset.to=String(this.range.to);this.svg.dataset.period=this.range.code;
        const primary=HISTORY_SERIES[this.def.keys[0]],state=this.owner.store.state;
        this.element.querySelector('.chart-subtitle').textContent=this.def.pressure ? (state.data?.pressureKind==='seaLevel'?'Tlak přepočtený na hladinu moře · hPa':state.data?.pressureKind==='absolute'?'Absolutní tlak v místě stanice · hPa':'Typ tlaku není uveden · hPa') : this.def.area ? 'Intenzita v čase · mm/h, nikoli úhrn v mm' : `Vývoj v čase · ${primary.unit}`;
        const available=[];let totalVisible=0;
        for(const key of this.def.keys){
          const stats=HistoryMath.stats(this.ranged[key]?.points??[]);const {button,unavailable}=this.legendButtons.get(key);
          button.disabled=stats.count===0;unavailable.hidden=stats.count>0;button.setAttribute('aria-pressed',String(!this.hidden.has(key)));
          if(stats.count>0 && !this.hidden.has(key)){available.push({key,stats});totalVisible+=stats.count;}
        }
        this.visibleKeys=available.map(item=>item.key);
        const allStats=HistoryMath.stats(this.ranged[this.def.keys[0]]?.points??[]);
        const last=this.element.querySelector('.chart-last-number');last.textContent=allStats.last?this.owner.number(allStats.last.v):'—';
        const minNode=this.element.querySelector('.chart-min'),maxNode=this.element.querySelector('.chart-max');
        minNode.textContent=allStats.count?`${this.owner.number(allStats.min)} ${primary.unit}`:'—';maxNode.textContent=allStats.count?`${this.owner.number(allStats.max)} ${primary.unit}`:'—';
        const left=primary.unit==='hPa'?60:46,right=12,top=12,bottom=31,height=this.frame.clientHeight,plotWidth=Math.max(1,width-left-right),plotHeight=height-top-bottom;
        let yMin=null,yMax=null;for(const {stats}of available){yMin=yMin===null?stats.min:Math.min(yMin,stats.min);yMax=yMax===null?stats.max:Math.max(yMax,stats.max);}
        const scale=HistoryMath.scale(yMin,yMax,this.def);
        const x=t=>left+(t-this.range.from)/Math.max(1,this.range.to-this.range.from)*plotWidth;
        const y=v=>top+(scale.max-v)/(scale.max-scale.min)*plotHeight;
        this.geometry={left,right,top,bottom,width,height,plotWidth,plotHeight,x,y};
        const grid=this.node('g',{'aria-hidden':'true'});
        const ticks=totalVisible?scale.ticks:[0,.25,.5,.75,1];
        for(const tick of ticks){const ty=totalVisible?y(tick):top+(1-tick)*plotHeight;grid.append(this.node('line',{x1:left,x2:width-right,y1:ty,y2:ty,class:'plot-grid-line'}));if(totalVisible)grid.append(this.node('text',{x:left-9,y:ty+3,'text-anchor':'end'},this.owner.tickNumber(tick)));}
        const tickCount=width<420?3:width<750?4:6;
        if(totalVisible)for(let i=0;i<tickCount;i++){const t=this.range.from+(this.range.to-this.range.from)*i/(tickCount-1),tx=left+plotWidth*i/(tickCount-1);grid.append(this.node('text',{x:tx,y:height-8,'text-anchor':i===0?'start':i===tickCount-1?'end':'middle'},this.owner.axisTime(t,this.range.to-this.range.from)));}
        this.svg.append(grid);
        let renderedPoints=0;
        const layers=this.node('g',{class:'plot-data-layer','aria-hidden':'true'});
        for(const {key}of available){
          const info=HISTORY_SERIES[key],input=this.ranged[key],sampled=HistoryMath.simplify(input.points,this.range.from,this.range.to,Math.min(200,Math.max(25,Math.floor(plotWidth/4))),input.maxGapMs);
          renderedPoints+=sampled.length;
          const runs=[];let run=[];let runId=null;
          for(const p of sampled){if(runId!==p.run && run.length){runs.push(run);run=[];}run.push(p);runId=p.run;}if(run.length)runs.push(run);
          for(const points of runs){
            const path=points.map((p,i)=>`${i?'L':'M'}${x(p.t).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
            if(this.def.area && points.length>1){const area=`${path} L${x(points.at(-1).t).toFixed(2)},${y(0).toFixed(2)} L${x(points[0].t).toFixed(2)},${y(0).toFixed(2)} Z`;layers.append(this.node('path',{d:area,fill:`var(--plot-${info.color})`,'fill-opacity':'.13'}));}
            if(points.length===1)layers.append(this.node('circle',{cx:x(points[0].t),cy:y(points[0].v),r:2,fill:`var(--plot-${info.color})`,'data-series':key}));
            else layers.append(this.node('path',{d:path,class:'plot-series-line',stroke:`var(--plot-${info.color})`,'stroke-dasharray':'none','data-series':key}));
          }
        }
        this.svg.append(layers);
        this.crosshair=this.node('line',{class:'plot-crosshair',x1:left,x2:left,y1:top,y2:height-bottom,visibility:'hidden','aria-hidden':'true'});this.svg.append(this.crosshair);
        this.markersGroup=this.node('g',{class:'plot-markers','aria-hidden':'true'});this.svg.append(this.markersGroup);
        this.svg.dataset.renderedPoints=String(renderedPoints);this.svg.dataset.sourcePoints=String(totalVisible);
        this.svg.setAttribute('aria-label',`${this.def.title}, ${primary.unit}. ${totalVisible?'Interaktivní graf. Šipkami procházejte původní měření.':'Ve vybraném období nejsou k dispozici zobrazené hodnoty.'}`);
        const hiddenAll=!available.length && this.def.keys.some(key=>HistoryMath.stats(this.ranged[key]?.points??[]).count>0);
        this.empty.hidden=totalVisible>0;
        let emptyTitle='V tomto období nejsou měření',emptyDetail='Zkus delší období nebo vyčkej na dostupná data.';
        if(hiddenAll){emptyTitle='Všechny řady jsou skryté';emptyDetail='Zapni alespoň jednu řadu v legendě.';}
        else if(state.status==='loading'){emptyTitle='Načítání historie';emptyDetail='Čekáme na údaje pro zobrazení průběhu.';}
        else if(state.status==='error'){emptyTitle='Historie není dostupná';emptyDetail='Údaje se nepodařilo načíst.';}
        else if(state.status==='unavailable'){emptyTitle='Historie zatím není připojena';emptyDetail='Po připojení se zde zobrazí vývoj měření.';}
        else if(!state.data?.total){emptyTitle='Historie je prázdná';emptyDetail='Nejsou k dispozici žádná historická měření.';}
        this.empty.querySelector('strong').textContent=emptyTitle;this.empty.querySelector('p').textContent=emptyDetail;
        this.element.querySelector('.chart-resolution').textContent=totalVisible?`${new Intl.NumberFormat('cs-CZ').format(totalVisible)} vzorků${renderedPoints<totalVisible?' · zachovaná extrema':''}`:'Bez hodnot';
        const lastState=this.element.querySelector('.chart-state');
        const dataLast=state.data?.series[this.def.keys[0]]?.points;
        const latest=HistoryMath.stats(dataLast??[]).last;
        lastState.textContent=latest && Date.now()-latest.t>this.owner.store.staleAfterMs?'Poslední dostupná měření jsou starší než nastavený limit.':'';
      }
      handleCoords(clientX,announce){
        if(!this.geometry || !this.visibleKeys?.length)return;
        const rect=this.svg.getBoundingClientRect();
        const x=Math.max(this.geometry.left,Math.min(this.geometry.width-this.geometry.right,clientX-rect.left));
        this.showTooltip(this.range.from+(x-this.geometry.left)/this.geometry.plotWidth*(this.range.to-this.range.from),announce);
      }
      pointer(event,announce){
        this.handleCoords(event.clientX,announce);
      }
      keyboard(event){
        if(event.key==='Escape'){this.hideTooltip();return;}
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || !this.visibleKeys?.length)return;
        event.preventDefault();
        const points=this.ranged[this.visibleKeys[0]].points.filter(p=>p.v!==null);if(!points.length)return;
        let index=this.cursorTime===null?points.length-1:Math.min(points.length-1,HistoryMath.lowerBound(points,this.cursorTime));
        if(event.key==='Home')index=0;else if(event.key==='End')index=points.length-1;else index=Math.max(0,Math.min(points.length-1,index+(event.key==='ArrowRight'?1:-1)));
        this.showTooltip(points[index].t,true);
      }
      showTooltip(requested,announce){
        const rows=this.visibleKeys.map(key=>({key,point:HistoryMath.nearest(this.ranged[key].points,requested,this.ranged[key].maxGapMs)}));
        const anchor=rows.find(row=>row.point)?.point?.t??requested;this.cursorTime=anchor;
        this.tooltip.replaceChildren();
        const title=document.createElement('p');title.className='plot-tooltip-title';title.textContent=this.owner.fullTime(anchor);this.tooltip.append(title);
        const summary=[title.textContent];
        for(const {key,point}of rows){
          const info=HISTORY_SERIES[key],row=document.createElement('div');row.className='plot-tooltip-row';row.style.setProperty('--series-color',`var(--plot-${info.color})`);
          const dot=document.createElement('span');dot.className='plot-tooltip-dot';const label=document.createElement('span');label.textContent=info.label;
          if(point && Math.abs(point.t-anchor)>1000){const ownTime=document.createElement('small');ownTime.textContent=this.owner.fullTime(point.t);label.append(ownTime);}
          const value=document.createElement('strong');value.textContent=point?`${this.owner.number(point.v)} ${info.unit}`:'Bez měření';row.append(dot,label,value);this.tooltip.append(row);summary.push(`${info.label}: ${value.textContent}${point&&point.t!==anchor?', '+this.owner.fullTime(point.t):''}`);
        }
        const primaryRow=rows.find(r=>r.key===this.def.keys[0]);
        const lastEl=this.element.querySelector('.chart-last-number');
        if(lastEl && primaryRow?.point && primaryRow.point.v!==null){
          lastEl.textContent=this.owner.number(primaryRow.point.v);
        }
        this.tooltip.hidden=false;
        const cx=this.geometry.x(anchor);
        const tooltipW=this.tooltip.offsetWidth||230;
        const frameW=this.frame.clientWidth||this.geometry.width;
        let left=cx+14;
        if(left+tooltipW>frameW-8){
          left=cx-tooltipW-14;
        }
        left=Math.max(6,Math.min(frameW-tooltipW-6,left));
        this.tooltip.style.left=`${left}px`;
        this.crosshair.setAttribute('visibility','hidden');
        if(this.markersGroup){
          this.markersGroup.replaceChildren();
          for(const {key,point} of rows){
            if(point && point.v!==null && Number.isFinite(point.v)){
              const info=HISTORY_SERIES[key];
              const px=this.geometry.x(point.t);
              const py=this.geometry.y(point.v);
              const color=`var(--plot-${info.color})`;
              const halo=this.node('circle',{class:'plot-marker-halo',cx:px.toFixed(2),cy:py.toFixed(2),r:8.5,fill:color,'fill-opacity':'.28'});
              const dot=this.node('circle',{class:'plot-marker-dot',cx:px.toFixed(2),cy:py.toFixed(2),r:5.5,fill:color,stroke:'var(--canvas, #101625)','stroke-width':'2.5'});
              this.markersGroup.append(halo,dot);
            }
          }
        }
        if(announce)this.element.querySelector('.plot-readout').textContent=summary.join('. ');
      }
      hideTooltip(){
        this.tooltip.hidden=true;
        this.cursorTime=null;
        if(this.crosshair)this.crosshair.setAttribute('visibility','hidden');
        if(this.markersGroup)this.markersGroup.replaceChildren();
        const state=this.owner.store.state;
        const dataLast=state.data?.series[this.def.keys[0]]?.points;
        const latest=HistoryMath.stats(dataLast??[]).last;
        const lastEl=this.element.querySelector('.chart-last-number');
        if(lastEl){
          lastEl.textContent=latest?this.owner.number(latest.v):'—';
        }
      }
    }

    class HistoryController {
      constructor(carousel){
        this.carousel=carousel;this.store=new HistoryStore();this.code=carousel.items[carousel.activeIndex].dataset.code;this.dirty=true;this.pending=null;
        this.dateFormatter=new Intl.DateTimeFormat('cs-CZ',{timeZone:'Europe/Prague',day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'short'});
        this.rangeDateFormatter=new Intl.DateTimeFormat('cs-CZ',{timeZone:'Europe/Prague',day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
        this.numberFormatter=new Intl.NumberFormat('cs-CZ',{maximumFractionDigits:1,minimumFractionDigits:1,useGrouping:false});
        this.charts=HISTORY_CHARTS.map(def=>new GlassHistoryChart(def,this));
        this.dock=document.querySelector('.top-dock');this.dockAnchor=document.createComment('Původní umístění společného časového přepínače');this.dock.before(this.dockAnchor);
        this.store.addEventListener('change',()=>this.schedule());
        window.addEventListener('meteo:timechange',event=>{if(document.body.dataset.section==='statistiky')return;this.code=event.detail.code;this.schedule();});
        window.addEventListener('meteo:sectionchange',()=>this.mount());
        window.addEventListener('pointerdown',event=>{if(!event.target.closest('.plot-frame'))this.charts.forEach(chart=>chart.hideTooltip());},{passive:true});
        setInterval(()=>{if(this.isActive() && !document.hidden)this.schedule();},60000);
        document.addEventListener('visibilitychange',()=>{if(!document.hidden && this.isActive())this.schedule();});
        this.mount();
        window.WeatherHistory=Object.freeze({
          accept:payload=>this.store.accept(payload),setLoading:()=>this.store.loading(),setError:message=>this.store.error(message),setUnavailable:()=>this.store.unavailable(),
          configure:options=>{if(Number.isFinite(options?.staleAfterMs)&&options.staleAfterMs>0){this.store.staleAfterMs=options.staleAfterMs;this.schedule();}},
          getState:()=>({status:this.store.state.status,receivedAt:this.store.state.receivedAt,first:this.store.state.data?.first??null,last:this.store.state.data?.last??null,total:this.store.state.data?.total??null,code:this.code,range:this.currentRange?{...this.currentRange}:null})
        });
      }
      isActive(){return document.body.dataset.section==='grafy';}
      mount(){if(this.isActive()){document.getElementById('graphsPeriodMount').append(this.dock);this.schedule();}else{this.dockAnchor.after(this.dock);this.charts.forEach(chart=>chart.hideTooltip());}}
      schedule(){this.dirty=true;if(!this.isActive()||this.pending)return;this.pending=requestAnimationFrame(()=>{this.pending=null;if(this.isActive()){this.render();this.dirty=false;}});}
      number(value){return this.numberFormatter.format(value);}
      tickNumber(value){return new Intl.NumberFormat('cs-CZ',{maximumFractionDigits:2,useGrouping:false}).format(value);}
      fullTime(time){return this.dateFormatter.format(time);}
      axisTime(time,span){
        let options=span<=86400000?{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}:span<=8*86400000?{day:'numeric',month:'numeric',hour:'2-digit',hourCycle:'h23'}:span<=180*86400000?{day:'numeric',month:'numeric'}:{month:'short',year:'2-digit'};
        return new Intl.DateTimeFormat('cs-CZ',{timeZone:'Europe/Prague',...options}).format(time);
      }
      render(){
        const state=this.store.state,data=state.data,range=HistoryMath.range(this.code,data);this.currentRange=range;
        document.getElementById('historyRange').textContent=!data?.total ? '—' : `${this.rangeDateFormatter.format(range.from)} — ${this.rangeDateFormatter.format(range.to)}`;
        document.getElementById('activeTimeIndicator').textContent=`Vybráno: ${this.carousel.items.find(item=>item.dataset.code===this.code)?.dataset.time??'24 hodin'}${this.code==='all'?' · celá dostupná historie':''}`;
        let title='Historie není připojena',tone='neutral',message='Historická měření zatím nejsou připojena. Pomlčka znamená chybějící hodnotu, nikoli nulu.';
        if(state.status==='loading'){title='Načítání historie';message=data?'Načítáme nové údaje. Do té doby je zobrazena poslední dostupná historie.':'Čekáme na historická měření. Prázdný graf není nulová naměřená hodnota.';}
        if(state.status==='error'){title='Historie není dostupná';tone='warning';message=state.message||(data?'Nové údaje se nepodařilo načíst. Grafy zobrazují poslední dostupnou historii.':'Historii se nepodařilo načíst. Čas posledního měření nevytváříme.');}
        if(state.status==='ready'){
          if(!data?.total || data.latestValueAt===null){title='Prázdná historie';message='V předané historii nejsou žádné platné naměřené hodnoty.';}
          else if(this.store.isStale()){title='Starší historie';tone='warning';message=`Nejnovější dostupné měření je starší než nastavený limit. ${this.code==='all'?'Zobrazena je celá dostupná historie.':'Vybrané období se stále počítá od současného času.'}`;}
          else {
            const incomplete=HISTORY_CHARTS.some(chart=>!data.series[chart.keys[0]].points.some(p=>p.v!==null)) || Object.values(data.series).some(series=>series.points.some(p=>p.v===null));
            title=incomplete?'Neúplná historie':'Historie je k dispozici';
            message=incomplete?'Některé řady chybí nebo obsahují mezery. Úseky bez měření se nepropojují a chybějící hodnoty se nepovažují za nulu.':'Všechny grafy sdílejí stejné období. Hodnoty, minima a maxima vycházejí z původních vzorků v daném rozsahu.';
          }
        }
        const hst = document.getElementById('historyStatusText'); if (hst) hst.textContent=title;
        const hs = document.getElementById('historyStatus'); if (hs) hs.dataset.tone=tone;
        const hm = document.getElementById('historyMessage'); if (hm) hm.textContent=message;
        const hu = document.getElementById('historyUpdated'); if (hu) hu.textContent=state.receivedAt===null?'Žádná historie dosud nebyla načtena.':`Poslední načtení historie: ${this.fullTime(state.receivedAt)}${data?.latestValueAt!=null?` · Nejnovější měření: ${this.fullTime(data.latestValueAt)}`:''}`;
        document.getElementById('historyGrid').setAttribute('aria-busy',String(state.status==='loading'));
        for(const chart of this.charts)chart.setData(range);
        const signature=`${range.code}:${range.from}:${range.to}`;
        if(signature!==this.rangeSignature){this.rangeSignature=signature;window.dispatchEvent(new CustomEvent('history:rangechange',{detail:{...range}}));}
      }
    }

    /* Statistiky — WeatherStatistics.accept(payload) přijímá records,
       asOf a scope {from,to,complete}. records obsahuje skutečné zdrojové
       řádky s id a time; ne graficky zjednodušené ani agregované body.
       Stejné id se počítá jednou, různé id v témže čase jsou různé záznamy.
       Úplnost dotazu je nutná pro přesný počet, neznamená souvislý chod senzorů.
       Každé období má vlastní rozsah, průměry používají platná měření.
       Chybějící hodnoty nejsou nuly; nárazy a intenzita mají vlastní pole.
       Z čítače se nikdy nepočítá intenzita. Úhrn vyžaduje ověřené rozdíly
       mezi odečty uvnitř okna a doložené resetování čítače.
    */
    const STATISTICS_PERIODS = [
      {code:'1h',title:'Poslední hodina',duration:3600000},
      {code:'24h',title:'Posledních 24 hodin',duration:86400000},
      {code:'7d',title:'Posledních 7 dní',duration:7*86400000},
      {code:'30d',title:'Posledních 30 dní',duration:30*86400000},
      {code:'60d',title:'Posledních 60 dní',duration:60*86400000},
      {code:'90d',title:'Posledních 90 dní',duration:90*86400000},
      {code:'180d',title:'Posledních 180 dní',duration:180*86400000},
      {code:'1y',title:'Posledních 365 dní',duration:365*86400000},
      {code:'all',title:'Celá dostupná historie',duration:null}
    ];
    const STATISTICS_METRICS = [
      {key:'outsideC',label:'Venkovní teplota',unit:'°C',icon:'outdoor',color:'orange'},
      {key:'insideC',label:'Vnitřní teplota',unit:'°C',icon:'indoor',color:'peach'},
      {key:'insideHumidity',label:'Vnitřní vlhkost',unit:'%',icon:'indoor-drop',color:'indigo',min:0,max:100},
      {key:'outsideHumidity',label:'Venkovní vlhkost',unit:'%',icon:'drop',color:'blue',min:0,max:100}
    ];
    const StatisticsMath = (()=>{
      function timestamp(value){if(typeof value!=='string'||!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value))return null;const t=Date.parse(value);return Number.isFinite(t)&&t<=Date.now()+60000?t:null;}
      function numeric(value,min=-Infinity,max=Infinity){return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?value:null;}
      function normalize(payload,receivedAt=Date.now()){
        if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new TypeError('Statistiky vyžadují objekt se zdrojovými záznamy.');
        if(!Array.isArray(payload.records))throw new TypeError('records musí být pole zdrojových záznamů; chybějící pole není prázdná historie.');
        const asOf=Math.min(timestamp(payload.asOf)??receivedAt,receivedAt),byId=new Map(),unidentified=[];let rejected=0;
        for(const item of Array.isArray(payload.records)?payload.records:[]){
          if(!item||typeof item!=='object'){rejected++;continue;}
          const t=timestamp(item.time);if(t===null||t>asOf){rejected++;continue;}
          const id=(typeof item.id==='string'&&item.id.trim()!=='')||(typeof item.id==='number'&&Number.isSafeInteger(item.id))?`${typeof item.id}:${item.id}`:null;
          const row={id,t,gustMps:numeric(item.gustMps,0),rainRateMmh:numeric(item.rainRateMmh,0),rainCounterMm:numeric(item.rainCounterMm,0),rainCounterEpoch:typeof item.rainCounterEpoch==='string'?item.rainCounterEpoch:null};
          for(const field of STATISTICS_METRICS)row[field.key]=numeric(item[field.key],field.min,field.max);
          if(item.rainCounterReset){const reset=item.rainCounterReset;row.reset={at:timestamp(reset.at),previousMm:numeric(reset.previousMm,0),initialMm:numeric(reset.initialMm,0)};}
          if(id===null)unidentified.push(row);else byId.set(id,row);
        }
        const records=[...byId.values(),...unidentified].sort((a,b)=>a.t-b.t);
        const scope={from:payload.scope?.from===null?null:timestamp(payload.scope?.from),fromKnown:payload.scope?.from===null||timestamp(payload.scope?.from)!==null,to:timestamp(payload.scope?.to),complete:payload.scope?.complete===true};
        // Chybné časové značky v odpovědi znemožňují důvěryhodný celkový počet.
        if(rejected)scope.complete=false;
        return {records,asOf,scope,rejected,first:records[0]?.t??null,last:records.at(-1)?.t??null};
      }
      function aggregate(records,key){let n=0,sum=0,min=Infinity,max=-Infinity;for(const row of records){const value=row[key];if(typeof value==='number'&&Number.isFinite(value)){n++;sum+=value;min=Math.min(min,value);max=Math.max(max,value);}}return{n,mean:n?sum/n:null,min:n?min:null,max:n?max:null};}
      function counterTotal(records){
        const points=records.filter(row=>Number.isFinite(row.rainCounterMm));if(points.length<2||points.at(-1).t===points[0].t)return{value:null,from:null,to:null,reason:'Chybí dva platné odečty čítače.'};
        let total=0;
        for(let i=1;i<points.length;i++){
          const a=points[i-1],b=points[i];
          if(b.t===a.t){if(b.rainCounterMm!==a.rainCounterMm)return{value:null,reason:'Ve stejném čase jsou rozporné odečty čítače.'};continue;}
          const reset=b.reset,epochChanged=a.rainCounterEpoch!==b.rainCounterEpoch;
          if(reset){
            if(reset.at===null||reset.at<a.t||reset.at>b.t||reset.previousMm===null||reset.initialMm===null||reset.previousMm<a.rainCounterMm||b.rainCounterMm<reset.initialMm)return{value:null,reason:'Reset čítače nelze spolehlivě vyhodnotit.'};
            total+=(reset.previousMm-a.rainCounterMm)+(b.rainCounterMm-reset.initialMm);
          }else if(epochChanged||b.rainCounterMm<a.rainCounterMm)return{value:null,reason:'Reset čítače není doložen potřebnými odečty.'};
          else total+=b.rainCounterMm-a.rainCounterMm;
        }
        return {value:total,from:points[0].t,to:points.at(-1).t,reason:null};
      }
      function period(data,definition,asOf){
        const from=definition.duration===null?(data?.first??null):asOf-definition.duration,to=asOf;
        const records=data?.records.filter(row=>(from===null||row.t>=from)&&row.t<=to)??[];
        const metrics={};for(const field of STATISTICS_METRICS)metrics[field.key]=aggregate(records,field.key);
        const gust=aggregate(records,'gustMps'),rain=aggregate(records,'rainRateMmh');
        const scope=data?.scope;
        const full=!!scope?.complete&&scope.fromKnown&&scope.to!==null&&scope.to>=to&&(scope.from===null||(from!==null&&scope.from!==null&&scope.from<=from));
        const countReliable=!!data&&full&&records.every(row=>row.id!==null);
        const rainfall=rain.n?{kind:'intensity',value:rain.max,n:rain.n,unit:'mm/h'}:{kind:'counter',...counterTotal(records),unit:'mm'};
        return{code:definition.code,from,to,metrics,gust:{value:gust.max,n:gust.n},rain:rainfall,count:countReliable?records.length:null,availableCount:records.length,full,countReliable};
      }
      function summarize(data,asOf=Date.now()){return STATISTICS_PERIODS.map(definition=>period(data,definition,asOf));}
      return {timestamp,numeric,normalize,aggregate,counterTotal,period,summarize};
    })();
    class StatisticsStore extends EventTarget {
      constructor(){super();this.state={status:'unavailable',data:null,receivedAt:null,message:null};this.staleAfterMs=900000;}
      publish(patch){Object.assign(this.state,patch);this.dispatchEvent(new Event('change'));}
      accept(payload){
        const receivedAt=Date.now();
        let data;
        if(payload && Array.isArray(payload.summaries)){
          data={asOf:receivedAt,summaries:payload.summaries,records:[]};
        }else{
          data=StatisticsMath.normalize(payload,receivedAt);
        }
        this.publish({status:'ready',data,receivedAt,message:null});
      }
      loading(){this.publish({status:'loading',message:null});}
      error(message){this.publish({status:'error',message:typeof message==='string'?message:null});}
      unavailable(){this.publish({status:'unavailable',data:null,receivedAt:null,message:null});}
    }

    class StatisticsController {
      constructor(carousel,history){
        this.carousel=carousel;this.history=history;this.store=new StatisticsStore();this.compact=window.matchMedia('(max-width:1099px)');this.isMounted=false;this.dirty=true;this.pending=null;this.scrollFrame=null;this.jumping=false;this.lastNavigation=0;
        this.fullDate=new Intl.DateTimeFormat('cs-CZ',{timeZone:'Europe/Prague',day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'short'});
        this.shortDate=new Intl.DateTimeFormat('cs-CZ',{timeZone:'Europe/Prague',day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
        this.formatNumber=new Intl.NumberFormat('cs-CZ',{minimumFractionDigits:1,maximumFractionDigits:1,useGrouping:false});this.formatCount=new Intl.NumberFormat('cs-CZ');
        let initial;try{initial=new URLSearchParams(location.search).get('statsPeriod');}catch(_){}
        this.selected=STATISTICS_PERIODS.some(p=>p.code===initial)?initial:'1h';this.initialAnchor=initial===this.selected;this.wasActivated=false;
        this.cards=new Map(STATISTICS_PERIODS.map(def=>[def.code,document.getElementById(`statistics-${def.code}`)]));
        window.addEventListener('meteo:sectionchange',()=>this.mount());
        window.addEventListener('meteo:timechange',event=>{if(this.isActive()&&this.compact.matches)this.navigate(event.detail.code);});
        this.carousel.items.forEach(item=>item.addEventListener('click',()=>{if(this.isActive()&&this.compact.matches&&!this.carousel.isDragging)this.navigate(item.dataset.code);}));
        this.carousel.control.addEventListener('keydown',event=>{if(this.isActive()&&this.compact.matches&&['Home','End','ArrowLeft','ArrowRight'].includes(event.key))this.navigate(this.carousel.items[this.carousel.activeIndex].dataset.code);});
        this.compact.addEventListener('change',()=>{if(this.isActive())this.mount();});
        window.addEventListener('scroll',()=>this.onScroll(),{passive:true});
        this.store.addEventListener('change',()=>this.schedule());
        setInterval(()=>{if(this.isActive()&&!document.hidden)this.updateStatus();},30000);
        this.mount();
        window.WeatherStatistics=Object.freeze({
          accept:payload=>this.store.accept(payload),setLoading:()=>this.store.loading(),setError:message=>this.store.error(message),setUnavailable:()=>this.store.unavailable(),
          configure:options=>{if(Number.isFinite(options?.staleAfterMs)&&options.staleAfterMs>0){this.store.staleAfterMs=options.staleAfterMs;this.updateStatus();}},
          getState:()=>({status:this.store.state.status,receivedAt:this.store.state.receivedAt,asOf:this.store.state.data?.asOf??null,selected:this.selected,compact:this.compact.matches,summaries:this.summaries?JSON.parse(JSON.stringify(this.summaries)):[]})
        });
      }
      isActive(){return document.body.dataset.section==='statistiky';}
      mount(){
        if(this.isActive()){
          const entering=!this.isMounted;this.isMounted=true;this.carousel.urlKey='statsPeriod';
          if(this.compact.matches){document.getElementById('statisticsPeriodMount').append(this.history.dock);this.carousel.control.setAttribute('aria-label','Přejít na statistiku období');}
          else this.history.dockAnchor.after(this.history.dock);
          this.carousel.items.forEach(item=>item.setAttribute('aria-controls',`statistics-${item.dataset.code}`));
          if(entering && (this.wasActivated||!this.initialAnchor))this.selected='1h';
          this.syncCarousel(this.selected);this.markCurrent();this.schedule();
          if(entering&&!this.wasActivated&&this.initialAnchor&&this.compact.matches)requestAnimationFrame(()=>this.navigate(this.selected));
          this.wasActivated=true;
        }else if(this.isMounted){
          this.isMounted=false;this.jumping=false;clearTimeout(this.scrollEndTimer);this.carousel.urlKey='time';this.carousel.control.setAttribute('aria-label','Časové období');this.carousel.items.forEach(item=>item.removeAttribute('aria-controls'));this.syncCarousel(this.history.code);
        }
      }
      syncCarousel(code){
        const c=this.carousel,index=c.items.findIndex(item=>item.dataset.code===code);if(index<0||c.pointerDown)return;
        cancelAnimationFrame(c.rafId);clearTimeout(c.collapseTimer);c.setInteracting(false);c.resetTransformState();c.measure();c.activeIndex=index;
        const target=c.calculateSnapTargets(index);c.currReelX=c.targetReelX=target.reelX;c.currLensX=c.targetLensX=target.lensX;c.render();c.lastUnderLensSlot=-1;c.updateUnderLensHighlight();
      }
      markCurrent(){for(const [code,node]of this.cards)node.dataset.current=String(this.selected===code);}
      navigationOffset(){const mount=document.getElementById('statisticsPeriodMount');return mount.offsetHeight+30+(parseFloat(getComputedStyle(mount).top)||0);}
      navigate(code){
        if(!this.isActive()||!this.compact.matches||!this.cards.has(code))return;
        const now=performance.now();if(this.selected===code&&this.jumping&&now-this.lastNavigation<100)return;
        this.lastNavigation=now;this.selected=code;this.markCurrent();updateUrlParam('statsPeriod',code);this.jumping=true;
        const node=this.cards.get(code),top=Math.max(0,window.scrollY+node.getBoundingClientRect().top-this.navigationOffset());
        window.scrollTo({top,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
        clearTimeout(this.scrollEndTimer);this.scrollEndTimer=setTimeout(()=>{this.jumping=false;this.scrollSpy();},180);
      }
      onScroll(){
        if(!this.isActive()||!this.compact.matches)return;
        if(this.jumping){clearTimeout(this.scrollEndTimer);this.scrollEndTimer=setTimeout(()=>{this.jumping=false;this.scrollSpy();},180);return;}
        if(this.scrollFrame!==null)return;this.scrollFrame=requestAnimationFrame(()=>{this.scrollFrame=null;this.scrollSpy();});
      }
      scrollSpy(){
        if(!this.isActive()||!this.compact.matches||this.jumping||this.carousel.pointerDown)return;
        const offset=this.navigationOffset()+Math.min(140,window.innerHeight*.2);let code='1h';
        for(const [candidate,node]of this.cards){if(node.getBoundingClientRect().top<=offset)code=candidate;else break;}
        if(code!==this.selected){this.selected=code;this.syncCarousel(code);this.markCurrent();updateUrlParam('statsPeriod',code);}
      }
      schedule(){this.dirty=true;if(!this.isActive()||this.pending!==null)return;this.pending=requestAnimationFrame(()=>{this.pending=null;if(this.isActive())this.render();});}
      number(value){return value===null||value===undefined?'—':this.formatNumber.format(value);}
      setValue(node,value,integer=false){node.textContent=value===null||value===undefined?'—':integer?this.formatCount.format(value):this.number(value);node.classList.toggle('stat-is-missing',value===null||value===undefined);}
      updateStatus(){
        const {status,data,receivedAt,message}=this.store.state;
        let title='Statistiky nejsou připojené',tone='neutral',detail='Historie zatím není připojena. Neznámá hodnota ani neznámý počet záznamů se nezobrazují jako nula.';
        if(status==='loading'){title='Načítání statistik';detail=data?'Načítáme nové podklady. Zatím jsou zobrazené poslední dostupné souhrny.':'Čekáme na podklady pro statistiky jednotlivých období.';}
        if(status==='error'){title='Statistiky nejsou dostupné';tone='warning';detail=message||(data?'Nové podklady se nepodařilo načíst. Zobrazené jsou poslední dostupné statistiky.':'Podklady pro výpočet statistik se nepodařilo načíst.');}
        if(status==='ready'){
          if(data.summaries){title='Souhrny jsou k dispozici';detail='Statistiky jednotlivých období z databáze Cloudflare D1.';}
          else if(!data.records.length){title='Prázdná historie';detail='V předané historii nejsou měřicí záznamy. Nulový počet se zobrazí jen při potvrzené úplnosti výběru.';}
          else if(Date.now()-data.asOf>this.store.staleAfterMs){title='Starší podklady';tone='warning';detail='Podklady jsou starší než nastavený limit. Časové rozsahy odpovídají výslovně uvedenému okamžiku snímku dat.';}
          else if(this.summaries?.some(s=>!s.countReliable)){title='Neúplné podklady';tone='warning';detail='Úplný počet záznamů nelze pro všechna období doložit. Hodnoty vycházejí pouze z dostupných platných měření.';}
          else if(this.summaries?.some(s=>s.availableCount>0&&(STATISTICS_METRICS.some(field=>s.metrics[field.key].n===0)||s.gust.n===0||(s.rain.kind!=='intensity'&&s.rain.value===null)))){title='Některé veličiny chybí';detail='Dostupné statistiky jsou vypočtené z platných měření. Chybějící veličiny nejsou nahrazené nulami.';}
          else{title='Souhrny jsou k dispozici';detail='Každé období se vyhodnocuje samostatně. Průměry používají jen platná měření; počet záznamů zahrnuje i existující neúplné záznamy.';}
        }
        const sst = document.getElementById('statisticsStatusText'); if (sst) sst.textContent=title;
        const ss = document.getElementById('statisticsStatus'); if (ss) ss.dataset.tone=tone;
        const sm = document.getElementById('statisticsMessage'); if (sm) sm.textContent=detail;
        const sa = document.getElementById('statisticsAsOf'); if (sa) sa.textContent=data?`Souhrny k ${this.fullDate.format(data.asOf)} · načtení podkladů: ${this.fullDate.format(receivedAt)} · Europe/Prague`:'Žádné podklady dosud nebyly načteny.';
        document.getElementById('statisticsGrid').setAttribute('aria-busy',String(status==='loading'));
      }
      render(){
        const {data,status}=this.store.state,asOf=data?.asOf??Date.now();
        this.summaries=data?.summaries ?? (data?.records?.length ? StatisticsMath.summarize(data,asOf) : []);
        for(const summary of this.summaries){
          const card=this.cards.get(summary.code);
          if(!card) continue;
          card.dataset.from=!data||summary.from===null?'':String(summary.from);card.dataset.to=data?String(summary.to):'';card.dataset.quality=data&&!summary.countReliable?'partial':status;
          const range=card.querySelector('.statistics-card-range');range.replaceChildren();
          if(!data||summary.from===null){range.textContent='—';}
          else{for(const [i,t]of [summary.from,summary.to].entries()){if(i)range.append(document.createTextNode(' — '));const time=document.createElement('time');time.dateTime=new Date(t).toISOString();time.textContent=this.shortDate.format(t);range.append(time);}}
          card.querySelector('.statistics-card-kind').textContent=data?'Souhrn měření':'Čeká na data';
          for(const field of STATISTICS_METRICS){
            const group=card.querySelector(`[data-metric="${field.key}"]`);
            if(!group) continue;
            const values=summary.metrics?.[field.key];
            if(values){for(const key of ['mean','max','min'])this.setValue(group.querySelector(`[data-value="${key}"]`),values[key]);}
            group.querySelector('.statistics-valid').textContent=data?`Platných hodnot: ${this.formatCount.format(values?.n ?? summary.availableCount ?? 0)} z ${this.formatCount.format(summary.availableCount ?? 0)} záznamů`:'Hodnoty zatím nejsou dostupné';
          }
          this.setValue(card.querySelector('[data-value="gust"]'),summary.gust?.value);card.querySelector('.statistics-gust-note').textContent=summary.gust?.n?`Z ${this.formatCount.format(summary.gust.n)} záznamů nárazů`:'Nárazy větru nejsou dostupné';
          const rain=summary.rain||{};this.setValue(card.querySelector('[data-value="rain"]'),rain.value);
          card.querySelector('.statistics-rain-label').textContent=rain.kind==='intensity'?'Maximální intenzita srážek':rain.value!==null?'Úhrn mezi odečty':'Maximální intenzita srážek';
          card.querySelector('.statistics-rain-unit').textContent=rain.kind==='intensity'?'mm/h':rain.value!==null?'mm':'mm/h';
          card.querySelector('.statistics-rain-note').textContent=rain.kind==='intensity'?`Z ${this.formatCount.format(rain.n)} měření intenzity`:rain.value!==null?`Intenzita není dostupná. Odečty: ${this.shortDate.format(rain.from)} — ${this.shortDate.format(rain.to)}`:data?(rain.reason||'Intenzita není dostupná'):'Intenzita zatím není dostupná';
          this.setValue(card.querySelector('.statistics-count-number'),summary.count ?? summary.availableCount,true);
          card.querySelector('.statistics-count-note').textContent=!data?'Počet není znám. Chybí měřicí záznamy.':summary.countReliable?'Počet jedinečných zdrojových záznamů v tomto rozsahu.':`Dostupných záznamů: ${this.formatCount.format(summary.availableCount ?? 0)}.`;
        }
        this.updateStatus();this.dirty=false;
      }
    }

    /* REKORDY — budoucí adaptér předává přes WeatherRecords.accept objekt:
       asOf: čas historického dotazu s explicitním časovým pásmem;
       history: {from, through, complete, firstMeasurementAt, lastMeasurementAt,
                 totalRecords, countVerified, countScope};
       extremes: slovník jednotlivých extrémů {value, unit, at}, případně
                 {value, from, to, complete, method, timeZone} pro úhrny.
       Datum prvního záznamu je minimum skutečných časů, nikoli začátek dotazu.
       countScope musí označovat all-history; počet vychází ze zdrojových řádků.
       complete potvrzuje úplnost výběru, nikoli nepřetržitý provoz senzorů.
       Chybějící údaje jsou null; nula znamená skutečně dodanou nulovou hodnotu.
       Při shodě extrémů se zachovává nejstarší výskyt. Vítr a náraz jsou oddělené.
       Úhrny vyžadují doložené intervaly, sucho navíc ověřené pokrytí a mezeru.
       Z čítačů se neodvozuje intenzita a mezery se automaticky nepřemosťují.
       Historická dolní mez odpovídá dříve zadanému počátku stanice;
       nezobrazuje se jako domnělý čas prvního skutečného záznamu.
    */
    const RECORDS_START = Date.parse('2026-05-10T22:00:00Z'); // 11. 5. 2026 00:00 Praha
    const RECORD_DEFINITIONS = [
      {key:'outsideMax',field:'outsideC',mode:'max',unit:'°C'},
      {key:'outsideMin',field:'outsideC',mode:'min',unit:'°C'},
      {key:'feelsMax',field:'feelsC',mode:'max',unit:'°C'},
      {key:'feelsMin',field:'feelsC',mode:'min',unit:'°C'},
      {key:'dewMax',field:'dewC',mode:'max',unit:'°C'},
      {key:'dewMin',field:'dewC',mode:'min',unit:'°C'},
      {key:'insideMax',field:'insideC',mode:'max',unit:'°C'},
      {key:'insideMin',field:'insideC',mode:'min',unit:'°C'},
      {key:'humidityOutMax',field:'outsideHumidity',mode:'max',unit:'%',min:0,max:100},
      {key:'humidityOutMin',field:'outsideHumidity',mode:'min',unit:'%',min:0,max:100},
      {key:'humidityInMax',field:'insideHumidity',mode:'max',unit:'%',min:0,max:100},
      {key:'humidityInMin',field:'insideHumidity',mode:'min',unit:'%',min:0,max:100},
      {key:'gustMax',field:'gustMps',mode:'max',unit:'m/s',wind:true,min:0},
      {key:'windMax',field:'windMps',mode:'max',unit:'m/s',wind:true,min:0},
      {key:'rainRateMax',field:'rainRateMmh',mode:'max',unit:'mm/h',min:0},
      {key:'rainHourMax',unit:'mm',period:'hour',min:0},
      {key:'rainDayMax',unit:'mm',period:'day',min:0},
      {key:'dryLongest',unit:'dní',period:'dry',min:0}
    ];
    const RecordsMath = (()=>{
      const localParts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Prague',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
      function parts(t){return Object.fromEntries(localParts.formatToParts(t).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));}
      function day(t){const p=parts(t);return `${p.year}-${p.month}-${p.day}`;}
      function timestamp(value){
        if(typeof value!=='string')return null;
        const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i);
        if(!m||+m[4]>23||+m[5]>59||+m[6]>59)return null;
        const calendar=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));
        if(calendar.getUTCFullYear()!==+m[1]||calendar.getUTCMonth()!==+m[2]-1||calendar.getUTCDate()!==+m[3])return null;
        const t=Date.parse(value);return Number.isFinite(t)?t:null;
      }
      function number(value,min=-Infinity,max=Infinity){return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?value:null;}
      function normalizeExtreme(item,def,upper){
        if(!item||typeof item!=='object')return null;
        const unit=def.wind?item.unit:def.unit;
        if(def.wind&&!['m/s','km/h'].includes(unit))return null;
        if(!def.wind&&item.unit!==undefined&&item.unit!==unit)return null;
        const inside=t=>t!==null&&t>=RECORDS_START&&t<=upper;
        if(!def.period){
          const value=number(item.value,def.min,def.max),at=item.at==null?null:timestamp(item.at);
          if(value===null||(item.at!=null&&!inside(at)))return null;
          return {value,unit,at,from:null,to:null};
        }
        const from=timestamp(item.from),to=timestamp(item.to);
        if(!inside(from)||!inside(to)||to<=from)return null;
        if(def.period==='dry'){
          // Doložené intervaly musí mít nulový úhrn; výpadky nelze přeskočit.
          const maxGap=number(item.maxGapMs,1),largestGap=number(item.largestGapMs,0);
          if(item.method!=='continuous-zero-rain'||item.coverageVerified!==true||item.thresholdMm!==0||maxGap===null||largestGap===null||largestGap>maxGap||maxGap>to-from||largestGap>to-from)return null;
          return {value:Math.floor((to-from)/86400000),unit,at:null,from,to,durationMs:to-from,maxGapMs:maxGap,largestGapMs:largestGap,ongoing:item.ongoing===true};
        }
        const value=number(item.value,0);
        if(value===null||item.complete!==true||item.timeZone!=='Europe/Prague')return null;
        const a=parts(from),b=parts(to);
        if(def.period==='hour'){
          if(item.method!=='calendar-hour'||to-from!==3600000||a.minute!=='00'||a.second!=='00'||from%1000!==0)return null;
        }else{
          const next=new Date(Date.parse(day(from)+'T00:00:00Z')+86400000).toISOString().slice(0,10);
          if(item.method!=='calendar-day'||a.hour!=='00'||b.hour!=='00'||a.minute!=='00'||b.minute!=='00'||a.second!=='00'||b.second!=='00'||from%1000!==0||to%1000!==0||day(to)!==next)return null;
        }
        return {value,unit,at:null,from,to};
      }
      function normalize(payload,receivedAt=Date.now()){
        if(!payload||typeof payload!=='object')throw new TypeError('Rekordy vyžadují objekt.');
        const asOf=payload.asOf==null?receivedAt:(timestamp(payload.asOf)??receivedAt);
        const h=payload.history||{};
        const last=timestamp(h.lastMeasurementAt) ?? (payload.newest_record ? Date.parse(payload.newest_record) : receivedAt);
        const first=timestamp(h.firstMeasurementAt) ?? (payload.oldest_record ? Date.parse(payload.oldest_record) : RECORDS_START);
        const total=number(payload.totalRecords ?? h.totalRecords ?? payload.total_records, 0);

        const records={};
        const rawExtremes = payload.extremes || payload.records || {};
        for(const def of RECORD_DEFINITIONS){
          const item = rawExtremes[def.key];
          if(item && typeof item==='object' && item.value!=null){
            records[def.key] = {
              value: item.value,
              unit: item.unit || def.unit,
              at: item.at ? (timestamp(item.at) ?? Date.parse(item.at)) : null,
              from: item.from ? (timestamp(item.from) ?? Date.parse(item.from)) : null,
              to: item.to ? (timestamp(item.to) ?? Date.parse(item.to)) : null
            };
          } else {
            records[def.key] = normalizeExtreme(rawExtremes[def.key], def, last ?? asOf);
          }
        }
        const available=Object.values(records).filter(Boolean).length;
        return {asOf,from:RECORDS_START,through:last,firstMeasurementAt:first,lastMeasurementAt:last,complete:true,records,totalRecords:total,available};
      }
      function fromSamples(samples,{asOf=new Date().toISOString(),complete=false}={}){
        if(!Array.isArray(samples))throw new TypeError('samples musí být pole měřicích záznamů.');
        const end=timestamp(asOf);if(end===null)throw new TypeError('Neplatný čas snímku.');
        const byId=new Map(),unidentified=[];let rejected=false;
        for(const row of samples){
          const t=timestamp(row?.time);if(t===null||t>end){rejected=true;continue;}if(t<RECORDS_START)continue;
          const item={...row,t},id=row.id;
          if((typeof id==='string'&&id.trim()!=='')||(typeof id==='number'&&Number.isSafeInteger(id)))byId.set(`${typeof id}:${id}`,item);else unidentified.push(item);
        }
        const rows=[...byId.values(),...unidentified],extremes={};let first=null,last=null;
        for(const row of rows){first=Math.min(first??row.t,row.t);last=Math.max(last??row.t,row.t);for(const def of RECORD_DEFINITIONS){
          if(!def.field)continue;const value=number(row[def.field],def.min,def.max);if(value===null)continue;
          const old=extremes[def.key],better=!old||(def.mode==='max'?value>old.value:value<old.value)||(value===old.value&&row.t<Date.parse(old.at));
          if(better)extremes[def.key]={value,unit:def.unit,at:new Date(row.t).toISOString()};
        }}
        return {asOf,history:{from:new Date(RECORDS_START).toISOString(),through:asOf,complete:complete&&!rejected,firstMeasurementAt:first===null?null:new Date(first).toISOString(),lastMeasurementAt:last===null?null:new Date(last).toISOString(),totalRecords:rows.length,countVerified:complete&&!rejected&&!unidentified.length,countScope:'all-history'},extremes};
      }
      return {timestamp,number,day,normalize,normalizeExtreme,fromSamples};
    })();
    class RecordsStore extends EventTarget {
      constructor(){super();this.state={status:'unavailable',data:null,receivedAt:null};this.staleAfterMs=900000;}
      publish(patch){Object.assign(this.state,patch);this.dispatchEvent(new Event('change'));}
      accept(payload){const receivedAt=Date.now(),data=RecordsMath.normalize(payload,receivedAt);this.publish({status:'ready',data,receivedAt});}
      loading(){this.publish({status:'loading'});}
      error(){this.publish({status:'error'});}
      unavailable(){this.publish({status:'unavailable',data:null,receivedAt:null});}
      isStale(now=Date.now()){const d=this.state.data;return !!d&&(now-d.asOf>this.staleAfterMs||(d.lastMeasurementAt!==null&&now-d.lastMeasurementAt>this.staleAfterMs));}
    }

    class RecordsController {
      constructor(){
        this.store=new RecordsStore();this.pending=null;
        this.number=new Intl.NumberFormat('cs-CZ',{maximumFractionDigits:1,minimumFractionDigits:1,useGrouping:false});
        this.count=new Intl.NumberFormat('cs-CZ');
        this.date=new Intl.DateTimeFormat('cs-CZ',{timeZone:'Europe/Prague',day:'numeric',month:'numeric',year:'numeric'});
        this.fullDate=new Intl.DateTimeFormat('cs-CZ',{timeZone:'Europe/Prague',day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'short'});
        this.cards=new Map(RECORD_DEFINITIONS.map(def=>[def.key,document.getElementById(`record-${def.key}`)]));
        this.store.addEventListener('change',()=>this.schedule());
        window.addEventListener('meteo:sectionchange',()=>this.schedule());
        document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.schedule();});
        setInterval(()=>{if(!document.hidden)this.schedule();},30000); // včetně změny dne v Praze
        window.WeatherRecords=Object.freeze({
          accept:payload=>this.store.accept(payload),fromSamples:(rows,scope)=>RecordsMath.fromSamples(rows,scope),
          setLoading:()=>this.store.loading(),setError:()=>this.store.error(),setUnavailable:()=>this.store.unavailable(),
          configure:options=>{if(Number.isFinite(options?.staleAfterMs)&&options.staleAfterMs>0){this.store.staleAfterMs=options.staleAfterMs;this.schedule();}},
          getState:()=>JSON.parse(JSON.stringify({...this.store.state,stale:this.store.isStale()}))
        });this.schedule();
      }
      isActive(){return document.body.dataset.section==='rekordy';}
      schedule(){if(!this.isActive()||this.pending!==null)return;this.pending=requestAnimationFrame(()=>{this.pending=null;if(this.isActive())this.render();});}
      text(id,value){const el=document.getElementById(id);if(el)el.textContent=value;}
      time(t,label){const node=document.createElement('time');node.dateTime=new Date(t).toISOString();node.textContent=`${label||''}${this.fullDate.format(t)}`;return node;}
      render(){
        const {data,status,receivedAt}=this.store.state,stale=this.store.isStale(),empty=data?.totalRecords===0&&data.available===0;
        let title='Historie není připojena',message='Historické rekordy zatím nejsou připojené. Pomlčka znamená nedostupný údaj, nikoli nulové měření.',tone='neutral';
        if(status==='loading'){title='Načítání rekordů';message=data?'Načítáme novou historii. Zatím zobrazujeme poslední dostupné podklady.':'Čekáme na historické podklady. Časy ani hodnoty rekordů nedoplňujeme odhadem.';}
        else if(status==='error'){title='Aktualizace se nezdařila';tone='warning';message=data?'Novou historii se nepodařilo načíst. Zůstávají zobrazené poslední dostupné rekordy a původní čas podkladů.':'Historie měření není dostupná. Bez podkladů nelze potvrdit rekordy ani celkový počet záznamů.';}
        else if(status==='ready'){
          if(!data.complete){title='Neúplná historie';tone='warning';message='Výběr nepokrývá celou dostupnou historii ve sledovaném rozsahu. Rekordy ani celkový počet nelze potvrdit.';}
          else if(empty){title='Prázdná historie';message='Ověřený historický výběr neobsahuje žádné záznamy. Nulový počet neznamená nulové meteorologické rekordy.';}
          else if(stale){title='Starší historické podklady';tone='warning';message='Historický snímek nebo poslední měření jsou starší než nastavený limit. Zobrazené rekordy nemusí zahrnovat nejnovější měření.';}
          else if(data.available<18||data.totalRecords===null){title='Část údajů není dostupná';message='Zobrazujeme ověřené dostupné extrémy. Některé veličiny, jejich metodika nebo přesný celkový počet chybí.';}
          else {title='Rekordy jsou k dispozici';message='Extrémy z celé dostupné historie ve sledovaném rozsahu. Při shodě se uvádí nejstarší výskyt; hodnoty z různých veličin se nezaměňují.';}
        }
        this.text('recordsStatusText',title);
        const rs = document.getElementById('recordsStatus'); if (rs) rs.dataset.tone=tone;
        this.text('recordsMessage',message);
        this.text('recordsAsOf',data?`Historický snímek k ${this.fullDate.format(data.asOf)} · přijetí podkladů: ${this.fullDate.format(receivedAt)}`:'Žádná historie dosud nebyla načtena.');
        document.getElementById('recordsContent').setAttribute('aria-busy',String(status==='loading'));
        for(const def of RECORD_DEFINITIONS){
          const node=this.cards.get(def.key),record=data?.records[def.key]??null,value=node.querySelector('.record-value');
          node.dataset.state=record?'available':'unavailable';value.classList.toggle('is-missing',!record);
          value.textContent=record?(def.period==='dry'?this.count.format(record.value):this.number.format(record.value)):'—';
          node.querySelector('.record-unit').textContent=record?.unit??def.unit;
          node.querySelector('.record-availability').textContent=record?(status==='error'||status==='loading'||stale?'Poslední dostupný rekord':'Historický rekord'):status==='loading'?'Načítání podkladů…':data&&!data.complete?'Nelze potvrdit z neúplné historie':empty?'Žádná měření':'Zatím nedostupné';
          const time=node.querySelector('.record-time');
          if(time){
            time.replaceChildren();
            if(record?.from!==null&&record?.from!==undefined){time.append(this.time(record.from,'Od: '),this.time(record.to,'Do: '));}
            else if(record?.at!==null&&record?.at!==undefined)time.append(this.time(record.at));
            else time.textContent=record?'Datum a čas nejsou dostupné':'Čas rekordu není k dispozici';
          }
        }
        this.renderHistoryWidget();
      }
      renderHistoryWidget(){
        const history=this.store.state.data,total=history?.totalRecords??null,first=history?.firstMeasurementAt??null;
        const count=document.getElementById('recordsTotal');count.textContent=total===null?'—':this.count.format(total);count.classList.toggle('is-missing',total===null);
        count.setAttribute('aria-label',total===null?'Počet záznamů není dostupný':`Počet záznamů: ${this.count.format(total)}`);
        const from=document.getElementById('recordsAvailableFrom');from.replaceChildren();from.classList.toggle('is-missing',first===null);
        if(first===null){from.textContent='—';from.setAttribute('aria-label','Datum prvního dostupného záznamu není známé');}
        else {const time=document.createElement('time');time.dateTime=new Date(first).toISOString();time.textContent=this.date.format(first);from.append(time);from.setAttribute('aria-label',`Záznamy od ${this.date.format(first)}`);}
      }
    }

    document.addEventListener('DOMContentLoaded', () => {
      const carousel = new LiquidSegCarousel();
      const nav = new SmoothLiquidNav();
      const themeSwitch = new LiquidSwitch('liquidSwitch');
      initializeCurrentPage(themeSwitch,nav,carousel);
      const history = new HistoryController(carousel);
      new StatisticsController(carousel,history);
      new RecordsController();
    });
  
