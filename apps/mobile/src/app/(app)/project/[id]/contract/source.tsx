import { normalizeForMatch } from '@shared/extraction/guards.ts';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { type ComponentType, type Ref, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView as RNWebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { BackLink, cardClass, ErrorText } from '@/components/deadlines/ui';
import { VoIcon } from '@/components/vo/icons';
import { type ContractDocument, documentUrl } from '@/lib/contract-documents';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/theme/use-theme';

// The bundled pdf.js viewer (scripts/pdf-viewer/build.mjs). Loaded once per session.
let viewerHtml: Promise<string> | null = null;
function loadViewer(): Promise<string> {
  viewerHtml ??= (async () => {
    const [asset] = await Asset.loadAsync(require('../../../../../../assets/pdf-viewer/viewer.html'));
    return await new File(asset.localUri ?? asset.uri).text();
  })().catch((e) => {
    viewerHtml = null;
    throw e;
  });
  return viewerHtml;
}

const BASE_URL = 'https://viewer.co-atrium.invalid/';

// The package's platform-neutral typings omit the ref that the iOS / Android components forward.
type WebViewHandle = { injectJavaScript: (script: string) => void };
const WebView = RNWebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebViewHandle> }>;

/**
 * The source of an extracted value: the document at that page with the cited words
 * highlighted. PDFs render with pdf.js; DOCX and images show the page's extracted text
 * (and the image) with the excerpt marked.
 */
export default function SourceViewer() {
  const { documentId, page, excerpt } = useLocalSearchParams<{ id: string; documentId: string; page?: string; excerpt?: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const target = Math.max(1, Number(page) || 1);
  const [doc, setDoc] = useState<ContractDocument | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<{ pages: number | null; page: number; found: boolean | null }>({ pages: null, page: target, found: null });
  const [fallback, setFallback] = useState(false);
  const web = useRef<WebViewHandle>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data, error: e } = await supabase.from('contract_documents').select('*').eq('id', documentId).maybeSingle();
      if (!live) return;
      if (e || !data) return setError('The document could not be found.');
      const d = data as ContractDocument;
      setDoc(d);
      const signed = await documentUrl(d.storage_path);
      if (!live) return;
      if (!signed) return setError('The document could not be opened.');
      setUrl(signed);
      if (d.mime === 'application/pdf') {
        try {
          const h = await loadViewer();
          if (live) setHtml(h);
        } catch {
          if (live) setFallback(true);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [documentId]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(e.nativeEvent.data);
      if (m.type === 'loaded') setState((s) => ({ ...s, pages: m.pages }));
      else if (m.type === 'page') setState((s) => ({ ...s, page: m.page, found: m.page === target ? m.found : s.found }));
      else if (m.type === 'error') setFallback(true);
    } catch {
      // ignore malformed messages
    }
  };

  const go = (n: number) => web.current?.injectJavaScript(`window.showPage(${Math.round(n)}); true;`);
  const injected = useMemo(
    () => (url ? `window.__VIEWER__ = ${JSON.stringify({ url, page: target, excerpt: excerpt ?? '' }).replace(/</g, '\\u003c')}; true;` : ''),
    [url, target, excerpt],
  );

  const pdf = doc?.mime === 'application/pdf' && !fallback;

  return (
    <View className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <View className="gap-2 border-b border-border px-6 pb-3 pt-4 dark:border-border-dark">
        <BackLink label="‹ Done" />
        <Text accessibilityRole="header" numberOfLines={1} className="font-manrope-bold text-lg text-text-primary dark:text-text-primary-dark">
          {doc?.filename ?? 'Source'}
        </Text>
        {!!excerpt && (
          <Text numberOfLines={3} className="font-manrope text-sm italic text-text-secondary dark:text-text-secondary-dark">“{excerpt}”</Text>
        )}
        {pdf && (
          <View className="flex-row items-center gap-3">
            <PageButton icon="chevron-left" label="Previous page" disabled={state.page <= 1} onPress={() => go(state.page - 1)} />
            <Text className="flex-1 text-center font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">
              Page {state.page}{state.pages ? ` of ${state.pages}` : ''}
            </Text>
            <PageButton icon="chevron-right" label="Next page" disabled={!!state.pages && state.page >= state.pages} onPress={() => go(state.page + 1)} />
          </View>
        )}
        {pdf && state.page !== target && (
          <Pressable accessibilityRole="button" onPress={() => go(target)} className="min-h-11 justify-center self-center active:opacity-70">
            <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">Back to page {target}</Text>
          </Pressable>
        )}
        {pdf && state.found === false && state.page === target && (
          <Text className="font-manrope text-xs text-amber-700 dark:text-amber-300">
            The cited words could not be located on the page image (common for scanned pages). Read the page to check.
          </Text>
        )}
        {doc?.pages_estimated && (
          <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">Word documents have no fixed pages: page numbers are estimates.</Text>
        )}
      </View>

      <ErrorText message={error} />
      {!doc && !error && <ActivityIndicator className="mt-6" color={theme.accent} />}

      {pdf && html && url ? (
        <WebView
          ref={web}
          source={{ html, baseUrl: BASE_URL }}
          originWhitelist={[BASE_URL, 'about:blank']}
          injectedJavaScriptBeforeContentLoaded={injected}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={(r: ShouldStartLoadRequest) => r.url === BASE_URL || r.url.startsWith('about:') || r.url.startsWith('blob:')}
          javaScriptEnabled
          allowFileAccess={false}
          setSupportMultipleWindows={false}
          style={{ flex: 1, backgroundColor: theme.background }}
          startInLoadingState
          renderLoading={() => <ActivityIndicator className="mt-6" color={theme.accent} />}
        />
      ) : doc && (!pdf || fallback) ? (
        <PageText doc={doc} url={url} page={target} excerpt={excerpt ?? ''} />
      ) : null}
    </View>
  );
}

function PageButton({ icon, label, disabled, onPress }: { icon: 'chevron-left' | 'chevron-right'; label: string; disabled: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`h-11 w-11 items-center justify-center rounded-button border border-border dark:border-border-dark ${disabled ? 'opacity-40' : 'active:opacity-70'}`}>
      <VoIcon name={icon} color={theme.textPrimary} size={20} />
    </Pressable>
  );
}

/** Splits `text` around the excerpt (normalised match) so it can be marked. */
function markExcerpt(text: string, excerpt: string): { before: string; hit: string; after: string } | null {
  if (!excerpt.trim()) return null;
  const words = normalizeForMatch(excerpt).split(' ').filter(Boolean);
  if (!words.length) return null;
  // Map each word of the page to its character offsets, then look for the excerpt's words in order.
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ norm: normalizeForMatch(m[0]), start: m.index!, end: m.index! + m[0].length }))
    .filter((t) => t.norm);
  const flat = tokens.flatMap((t) => t.norm.split(' ').map((w) => ({ w, start: t.start, end: t.end })));
  for (let i = 0; i + words.length <= flat.length; i++) {
    if (words.every((w, j) => flat[i + j].w === w)) {
      const start = flat[i].start;
      const end = flat[i + words.length - 1].end;
      return { before: text.slice(0, start), hit: text.slice(start, end), after: text.slice(end) };
    }
  }
  return null;
}

function PageText({ doc, url, page, excerpt }: { doc: ContractDocument; url: string | null; page: number; excerpt: string }) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    supabase.from('document_pages').select('text').eq('document_id', doc.id).eq('page_no', page).maybeSingle()
      .then(({ data }) => live && setText((data?.text as string | undefined) ?? ''));
    return () => {
      live = false;
    };
  }, [doc.id, page]);
  const parts = text ? markExcerpt(text, excerpt) : null;

  return (
    <ScrollView contentContainerClassName="px-6 pt-4 gap-4" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
      {doc.mime.startsWith('image/') && url && (
        <Image source={{ uri: url, cacheKey: doc.storage_path }} contentFit="contain" style={{ width: '100%', aspectRatio: 0.75 }} accessibilityLabel={`Photo of ${doc.filename}`} />
      )}
      <Text accessibilityRole="header" className="font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
        Text of page {page}
      </Text>
      {text === null ? (
        <ActivityIndicator />
      ) : (
        <View className={`${cardClass} p-4`}>
          <Text selectable className="font-manrope text-sm leading-6 text-text-primary dark:text-text-primary-dark">
            {parts ? (
              <>
                {parts.before}
                <Text className="bg-accent/20 font-manrope-bold text-text-primary underline dark:bg-accent-dark/30 dark:text-text-primary-dark">{parts.hit}</Text>
                {parts.after}
              </>
            ) : (text || 'No text was read from this page.')}
          </Text>
        </View>
      )}
      {text !== null && excerpt && !parts && (
        <Text className="font-manrope text-xs text-amber-700 dark:text-amber-300">The cited words could not be located exactly in this page’s text.</Text>
      )}
    </ScrollView>
  );
}
