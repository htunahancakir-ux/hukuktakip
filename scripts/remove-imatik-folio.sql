-- Retire the unused field from live and archived document records.
DO $retire$
DECLARE removed_count bigint;
BEGIN
 PERFORM id FROM han_data.control WHERE id=1 FOR UPDATE;
 UPDATE han_data.documents SET body=body-'imatikFolioNumber',revision=revision+1,updated_at=clock_timestamp()
 WHERE body ? 'imatikFolioNumber';
 GET DIAGNOSTICS removed_count=ROW_COUNT;
 UPDATE han_data.document_archives SET body=body#-'{document,imatikFolioNumber}',revision=revision+1,updated_at=clock_timestamp()
 WHERE body->'document' ? 'imatikFolioNumber';
 IF removed_count>0 THEN
  INSERT INTO han_private.han_audit(category,action,area,actor_name,record_ref,fields)
  VALUES('changes','update','İ.Matik alanının kaldırılması','Kullanıcı talebiyle sistem düzenlemesi',removed_count::text,ARRAY['Kullanılmayacak alan aktif ve arşiv föylerinden kaldırıldı.']);
 END IF;
END;
$retire$;
