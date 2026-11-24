import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DocumentStatusBadge, UploadProgress } from '@/components/contract/badges';
import { BackLink, cardClass, Disclaimer, ErrorText, PrimaryButton, Title } from '@/components/deadlines/ui';
import { VoIcon } from '@/components/vo/icons';
import { useContract } from '@/hooks/use-contract';
import { useContractDocuments } from '@/hooks/use-contract-documents';
import {
  type ContractDocument,
  documentErrorMessage,
  formatBytes,
  pickDocuments,
  type PickedDocument,
  retryDocument,
  STEP_LABEL,
  type UploadHandle,
  uploadContractDocument,
} from '@/lib/contract-documents';
import { useTheme } from '@/theme/use-theme';

type Upload = { key: string; doc: PickedDocument; fraction: number; error: string | null; handle: UploadHandle | null };

/** Upload contract documents and follow their extraction live. */
export default function ContractDocumentsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const contract = useContract(id);
  const docs = useContractDocuments(id);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);

  const patch = useCallback((key: string, p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x))), []);

  const start = useCallback(
    (doc: PickedDocument, key: string) => {
      const handle = uploadContractDocument(id, doc, (fraction) => patch(key, { fraction }));
      patch(key, { handle, error: null, fraction: 0 });
      handle.promise
        .then(() => {
          setUploads((u) => u.filter((x) => x.key !== key));
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          docs.reload();
        })
        .catch((e) => patch(key, { error: documentErrorMessage(e), handle: null }));
    },
    [id, patch, docs],
  );

  const add = async () => {
    setNotice(null);
    const { picked, rejected } = await pickDocuments();
    if (rejected.length) setNotice(rejected.join('\n'));
    const fresh = picked.map((doc) => ({ key: `u${seq.current++}`, doc, fraction: 0, error: null, handle: null }));
    setUploads((u) => [...fresh, ...u]);
    fresh.forEach((u) => start(u.doc, u.key));
  };

  const renderDoc = ({ item }: { item: ContractDocument }) => <DocumentRow doc={item} projectId={id} canConfirm={contract.canConfirm} onChanged={docs.reload} />;

  return (
    <View className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <FlatList
        data={docs.documents}
        keyExtractor={(d) => d.id}
        renderItem={renderDoc}
        ItemSeparatorComponent={() => <View className="h-3" />}
        contentContainerClassName="px-6 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await docs.reload();
              setRefreshing(false);
            }}
            tintColor={theme.accent}
            colors={[theme.accent]}
          />
        }
        ListHeaderComponent={
          <View className="mb-4">
            <BackLink />
            <Title subtitle="Upload the contract (articles, appendix, particular conditions, preliminaries) as PDF, Word or photos. Values are proposed for review; nothing is applied until someone confirms it.">
              Contract documents
            </Title>
            {contract.isStaff ? (
              <PrimaryButton label="Add documents" onPress={add} />
            ) : (
              <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">Only project owners and members can upload contract documents.</Text>
            )}
            {notice && <Text className="mt-3 font-manrope text-sm text-amber-700 dark:text-amber-300">{notice}</Text>}

            {uploads.map((u) => (
              <View key={u.key} className={`${cardClass} mt-3 gap-2 p-4`}>
                <View className="flex-row items-center gap-2">
                  <VoIcon name="file" color={theme.textPrimary} size={18} />
                  <Text numberOfLines={1} className="flex-1 font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{u.doc.name}</Text>
                  <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{formatBytes(u.doc.size)}</Text>
                </View>
                {u.error ? (
                  <>
                    <ErrorText message={u.error} />
                    <View className="flex-row gap-4">
                      <TextButton label="Try again" onPress={() => start(u.doc, u.key)} />
                      <TextButton label="Remove" onPress={() => setUploads((x) => x.filter((y) => y.key !== u.key))} />
                    </View>
                  </>
                ) : (
                  <>
                    <UploadProgress fraction={u.fraction} label={`Uploading ${u.doc.name}`} />
                    <View className="flex-row items-center justify-between">
                      <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
                        {u.fraction >= 1 ? 'Starting extraction…' : `Uploading ${Math.round(u.fraction * 100)}%`}
                      </Text>
                      {u.fraction < 1 && <TextButton label="Cancel" onPress={() => u.handle?.cancel()} />}
                    </View>
                  </>
                )}
              </View>
            ))}

            {docs.loading && <ActivityIndicator className="mt-4" color={theme.accent} />}
            {docs.failed && <ErrorText message="Documents could not be loaded. Pull to retry." />}
            {!docs.loading && !docs.documents.length && !uploads.length && (
              <Text className="mt-6 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">No documents yet.</Text>
            )}
            {!!docs.documents.length && (
              <Text accessibilityRole="header" className="mt-6 font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
                Uploaded
              </Text>
            )}
          </View>
        }
        ListFooterComponent={<Disclaimer />}
      />
    </View>
  );
}

function TextButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8} className="min-h-11 justify-center active:opacity-70">
      <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">{label}</Text>
    </Pressable>
  );
}

function DocumentRow({ doc, projectId, canConfirm, onChanged }: { doc: ContractDocument; projectId: string; canConfirm: boolean; onChanged: () => void }) {
  const theme = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = doc.extraction_status === 'queued' || doc.extraction_status === 'processing';
  const meta = [
    formatBytes(doc.size_bytes),
    doc.page_count ? `${doc.page_count} page${doc.page_count === 1 ? '' : 's'}${doc.pages_estimated ? ' (estimated)' : ''}` : null,
    new Date(doc.created_at).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' }),
  ].filter(Boolean).join(' · ');

  return (
    <View className={`${cardClass} gap-2 p-4`}>
      <View className="flex-row items-start gap-2">
        <VoIcon name="file" color={theme.textPrimary} size={18} />
        <View className="flex-1 gap-0.5">
          <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{doc.filename}</Text>
          <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{meta}</Text>
        </View>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <DocumentStatusBadge status={doc.extraction_status} />
        {working && (
          <View className="flex-row items-center gap-2">
            <ActivityIndicator size="small" color={theme.textSecondary} />
            <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
              {STEP_LABEL[doc.extraction_step ?? ''] ?? 'Waiting to start'}
            </Text>
          </View>
        )}
      </View>
      {doc.warnings.map((w) => (
        <View key={w} className="flex-row gap-2">
          <VoIcon name="alert" color={theme.textSecondary} size={14} />
          <Text className="flex-1 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{w}</Text>
        </View>
      ))}
      {doc.extraction_status === 'failed' && (
        <>
          <Text className="font-manrope text-sm text-red-700 dark:text-red-400">{doc.error ?? 'Extraction failed.'}</Text>
          <TextButton
            label={busy ? 'Retrying…' : 'Try again'}
            onPress={async () => {
              setBusy(true);
              const err = await retryDocument(doc.id);
              setBusy(false);
              setError(err ? documentErrorMessage(err) : null);
              onChanged();
            }}
          />
        </>
      )}
      {(doc.extraction_status === 'needs_review' || doc.extraction_status === 'complete') && (
        <TextButton
          label={doc.extraction_status === 'needs_review' ? (canConfirm ? 'Review extracted values' : 'See extracted values') : 'See extracted values'}
          onPress={() => router.push({ pathname: '/project/[id]/contract/review', params: { id: projectId, documentId: doc.id } })}
        />
      )}
      <ErrorText message={error} />
    </View>
  );
}
